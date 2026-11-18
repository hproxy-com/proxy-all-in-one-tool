/* HProxy for Flipper Zero.
 *
 * Free proxies from hproxy.com and a proxy checker on the Flipper, over the WiFi Devboard (or an
 * ESP32, Pico W or BW16 board) flashed with FlipperHTTP 2.2 or newer:
 * https://github.com/jblanked/FlipperHTTP
 *
 * The board keeps its WiFi networks itself (set up once in the FlipperHTTP app) and joins them
 * when it starts, so this app only asks whether it is online. Every request runs in a worker
 * thread while the screen shows how far it got, and Back always leaves.
 *
 * Files in apps_data/hproxy on the SD card:
 *   proxies.txt  your own list, one host:port per line; lines with a login stay on the Flipper
 *   free.txt     the last free list fetched here
 *   alive.txt    the proxies that answered in the last check
 */
#include <furi.h>
#include <gui/gui.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
#include <gui/modules/text_box.h>
#include <gui/modules/variable_item_list.h>
#include <storage/storage.h>
#include <expansion/expansion.h>

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include <flipper_http/flipper_http.h>
#include "hproxy_api.h"

#define TAG "HProxy"

#define HPROXY_DIR EXT_PATH("apps_data/hproxy")
#define PATH_MINE HPROXY_DIR "/proxies.txt"
#define PATH_FREE HPROXY_DIR "/free.txt"
#define PATH_ALIVE HPROXY_DIR "/alive.txt"

#define LIST_READ_MAX (8 * 1024) /* the most of a list file read */
#define CHECK_MAX 50 /* proxies per check */
#define LINE_QUEUE 64 /* board lines waiting for the worker */
#define WORKER_STACK (6 * 1024)
#define WAIT_PONG_MS 2000
#define WAIT_STATUS_MS 3000
#define WAIT_SILENCE_MS 25000 /* a request is given up after this long without a line */
#define WAIT_END_MS 3000 /* after Back, how long a running answer may finish */
#define RATE_PAUSE_MS 5000 /* the checker takes 10 requests at once, then one every 5 s */

typedef enum {
    ViewMenu,
    ViewFree,
    ViewText,
} ViewId;

typedef enum {
    MenuFree,
    MenuCheckMine,
    MenuCheckFree,
    MenuSetup,
} MenuIndex;

typedef enum {
    EventUpdate = 1,
    EventDone,
} EventId;

typedef enum {
    JobFreeList,
    JobCheckMine,
    JobCheckFree,
} Job;

typedef enum {
    BoardReady,
    BoardNoPort,
    BoardMissing,
    BoardOffline,
} BoardState;

typedef enum {
    AnswerDone,
    AnswerFailed,
    AnswerSilent,
    AnswerCancelled,
} AnswerEnd;

static const char* const PROTOCOL_NAMES[] = {"Any", "HTTP", "HTTPS", "SOCKS4", "SOCKS5"};
static const char* const PROTOCOL_PARAMS[] = {NULL, "http", "https", "socks4", "socks5"};
static const char* const COUNTRIES[] =
    {"Any", "US", "DE", "GB", "FR", "NL", "CA", "JP", "SG", "BR", "IN", "ID", "PL", "TR"};
static const uint8_t COUNTS[] = {5, 10, 20, 30, 50};
static const char* const COUNT_NAMES[] = {"5", "10", "20", "30", "50"};

static const char SETUP_TEXT[] =
    "HProxy runs on a WiFi board flashed with FlipperHTTP 2.2 or newer: the WiFi Devboard, or an "
    "ESP32, Pico W or BW16 board.\n"
    "\n"
    "1. Flash FlipperHTTP onto the board: github.com/jblanked/FlipperHTTP\n"
    "\n"
    "2. Set up WiFi once in the FlipperHTTP app. The board remembers it and joins by itself.\n"
    "\n"
    "3. Free proxies: pick a protocol, a country and how many, then Get the list. It is saved as "
    "apps_data/hproxy/free.txt.\n"
    "\n"
    "4. Your own list: put it on the SD card as apps_data/hproxy/proxies.txt, one host:port per "
    "line. Lines with a login stay on your Flipper: they are never sent.\n"
    "\n"
    "Checks run on hproxy.com, ten proxies at a time, with 1.5 seconds per proxy. The ones that "
    "answer are saved as apps_data/hproxy/alive.txt.\n"
    "\n"
    "hproxy.com";

typedef struct {
    Gui* gui;
    ViewDispatcher* view_dispatcher;
    Submenu* menu;
    VariableItemList* free_options;
    TextBox* text_box;
    ViewId view;
    ViewId text_back; /* where Back leads from the text view */

    Expansion* expansion;
    FlipperHTTP* fhttp; /* NULL when the GPIO serial port could not be opened */
    FuriMessageQueue* lines; /* FuriString* lines from the board's receive thread */

    FuriThread* worker;
    volatile bool cancel;
    Job job;

    FuriMutex* mutex;
    FuriString* work_text; /* written by the worker, under mutex */
    FuriString* show_text; /* what the text box shows: the GUI thread's own copy */

    uint8_t protocol_index;
    uint8_t country_index;
    uint8_t count_index;
    const char* free_protocol; /* the protocol of the free list fetched in this session */
} App;

/* ---- files -------------------------------------------------------------------------------- */

static bool file_write(const char* path, FuriString* content) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    storage_simply_mkdir(storage, HPROXY_DIR);
    File* file = storage_file_alloc(storage);
    size_t size = furi_string_size(content);
    bool ok = storage_file_open(file, path, FSAM_WRITE, FSOM_CREATE_ALWAYS) &&
              storage_file_write(file, furi_string_get_cstr(content), size) == size;
    storage_file_close(file);
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return ok;
}

static bool file_read(const char* path, FuriString* out, size_t limit) {
    furi_string_reset(out);
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);
    bool ok = storage_file_open(file, path, FSAM_READ, FSOM_OPEN_EXISTING);
    if(ok) {
        char buffer[129];
        size_t total = 0;
        while(total < limit) {
            size_t want = limit - total;
            if(want > sizeof(buffer) - 1) want = sizeof(buffer) - 1;
            size_t got = storage_file_read(file, buffer, want);
            if(got == 0) break;
            buffer[got] = '\0';
            furi_string_cat_str(out, buffer);
            total += got;
        }
    }
    storage_file_close(file);
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return ok;
}

/* ---- the text on screen --------------------------------------------------------------------- */

/* Worker side: change the text, then ask the GUI thread to show it. */
static void text_printf(App* app, bool append, const char* format, ...) {
    va_list args;
    va_start(args, format);
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    if(append) {
        furi_string_cat_vprintf(app->work_text, format, args);
    } else {
        furi_string_vprintf(app->work_text, format, args);
    }
    furi_mutex_release(app->mutex);
    va_end(args);
    view_dispatcher_send_custom_event(app->view_dispatcher, EventUpdate);
}

/* GUI side: the text box lets go of the old text before its copy changes. */
static void show_update(App* app) {
    text_box_set_text(app->text_box, "");
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    furi_string_set(app->show_text, app->work_text);
    furi_mutex_release(app->mutex);
    text_box_set_text(app->text_box, furi_string_get_cstr(app->show_text));
}

static void view_switch(App* app, ViewId view) {
    app->view = view;
    view_dispatcher_switch_to_view(app->view_dispatcher, view);
}

/* ---- the WiFi board ------------------------------------------------------------------------- */

/* Runs in FlipperHTTP's receive thread, whose stack is small: it only hands the line on. */
static void board_line(const char* line, void* context) {
    App* app = context;
    FuriString* copy = furi_string_alloc_set_str(line);
    if(furi_message_queue_put(app->lines, &copy, 0) != FuriStatusOk) {
        furi_string_free(copy);
    }
}

static void lines_clear(App* app) {
    FuriString* line;
    while(furi_message_queue_get(app->lines, &line, 0) == FuriStatusOk) {
        furi_string_free(line);
    }
}

/* The next line from the board within `wait_ms`, or NULL. The caller frees it. */
static FuriString* line_next(App* app, uint32_t wait_ms) {
    FuriString* line;
    if(furi_message_queue_get(app->lines, &line, furi_ms_to_ticks(wait_ms)) == FuriStatusOk) {
        return line;
    }
    return NULL;
}

static bool elapsed(uint32_t since, uint32_t ms) {
    return furi_get_tick() - since >= furi_ms_to_ticks(ms);
}

static BoardState board_check(App* app) {
    if(!app->fhttp) return BoardNoPort;

    lines_clear(app);
    if(!flipper_http_send_command(app->fhttp, HTTP_CMD_PING)) return BoardMissing;
    bool pong = false;
    uint32_t start = furi_get_tick();
    while(!pong && !app->cancel && !elapsed(start, WAIT_PONG_MS)) {
        FuriString* line = line_next(app, 100);
        if(line) {
            pong = strstr(furi_string_get_cstr(line), "[PONG]") != NULL;
            furi_string_free(line);
        }
    }
    if(!pong) return BoardMissing;

    lines_clear(app);
    if(!flipper_http_send_command(app->fhttp, HTTP_CMD_STATUS)) return BoardMissing;
    start = furi_get_tick();
    while(!app->cancel && !elapsed(start, WAIT_STATUS_MS)) {
        FuriString* line = line_next(app, 100);
        if(!line) continue;
        bool online = furi_string_cmp_str(line, "true") == 0;
        bool offline = furi_string_cmp_str(line, "false") == 0;
        furi_string_free(line);
        if(online) return BoardReady;
        if(offline) return BoardOffline;
    }
    return BoardOffline;
}

static const char* board_problem(BoardState state) {
    switch(state) {
    case BoardNoPort:
        return "The GPIO serial port is in use by something else.\n\n"
               "Close other GPIO apps, then open HProxy again.";
    case BoardMissing:
        return "No WiFi board answered.\n\n"
               "Plug in the WiFi Devboard (or another board) flashed with FlipperHTTP 2.2 or "
               "newer, then try again. See How to set up.";
    case BoardOffline:
        return "The WiFi board is not online.\n\n"
               "Set up WiFi once in the FlipperHTTP app: the board remembers it and joins by "
               "itself.";
    default:
        return "";
    }
}

typedef void (*LineHandler)(const char* line, void* context);

/* One request through the board. Each line of the answer goes to `handle`; `status` gets the HTTP
 * status the board reported, or -1. */
static AnswerEnd board_request(
    App* app,
    HTTPMethod method,
    const char* url,
    const char* headers,
    const char* payload,
    LineHandler handle,
    void* context,
    int* status,
    FuriString* error) {
    *status = -1;
    lines_clear(app);
    if(!flipper_http_request(app->fhttp, method, url, headers, payload)) {
        furi_string_set_str(error, "The WiFi board did not take the request.");
        return AnswerFailed;
    }
    uint32_t last = furi_get_tick();
    uint32_t cancelled_at = 0;
    for(;;) {
        if(app->cancel && !cancelled_at) cancelled_at = furi_get_tick();
        /* After Back, the answer may still finish, so the next request starts on a quiet line. */
        if(cancelled_at && elapsed(cancelled_at, WAIT_END_MS)) return AnswerCancelled;
        FuriString* line = line_next(app, 100);
        if(!line) {
            if(elapsed(last, WAIT_SILENCE_MS)) return cancelled_at ? AnswerCancelled : AnswerSilent;
            continue;
        }
        last = furi_get_tick();
        const char* text = furi_string_get_cstr(line);
        if(hproxy_board_end(text)) {
            furi_string_free(line);
            return cancelled_at ? AnswerCancelled : AnswerDone;
        }
        if(hproxy_board_error(text)) {
            const char* message = text + strlen("[ERROR]");
            while(*message == ' ')
                message++;
            furi_string_set_str(error, message);
            furi_string_free(line);
            return cancelled_at ? AnswerCancelled : AnswerFailed;
        }
        int code = hproxy_board_status(text);
        if(code >= 0) {
            *status = code;
        } else if(!hproxy_board_line(text) && handle && !cancelled_at) {
            handle(text, context);
        }
        furi_string_free(line);
    }
}

static void report_failure(App* app, AnswerEnd end, FuriString* error) {
    if(end == AnswerSilent) {
        text_printf(
            app,
            false,
            "The WiFi board stopped answering.\n\nIs it still plugged in, and is its WiFi "
            "in reach?");
    } else {
        text_printf(app, false, "The WiFi board reported a problem:\n\n%s", furi_string_get_cstr(error));
    }
}

/* Waits `ms`, or less when Back was pressed. */
static void pause_ms(App* app, uint32_t ms) {
    uint32_t start = furi_get_tick();
    while(!app->cancel && !elapsed(start, ms)) {
        furi_delay_ms(100);
    }
}

/* ---- free proxies --------------------------------------------------------------------------- */

typedef struct {
    FuriString* list; /* one host:port per line */
    size_t count;
} FreeList;

static void free_list_line(const char* line, void* context) {
    FreeList* free_list = context;
    char proxy[HPROXY_PROXY_MAX];
    if(hproxy_proxy_from_line(line, proxy, sizeof(proxy)) == HproxyLineProxy) {
        furi_string_cat_printf(free_list->list, "%s\n", proxy);
        free_list->count++;
    }
}

static void job_free_list(App* app) {
    const char* protocol = PROTOCOL_PARAMS[app->protocol_index];
    const char* country = app->country_index ? COUNTRIES[app->country_index] : NULL;
    unsigned count = COUNTS[app->count_index];
    char url[192];
    if(!hproxy_list_url(url, sizeof(url), protocol, country, count)) {
        text_printf(app, false, "These options do not make a request.");
        return;
    }
    text_printf(
        app,
        false,
        "Asking hproxy.com for %u free %s%sproxies%s%s...",
        count,
        protocol ? PROTOCOL_NAMES[app->protocol_index] : "",
        protocol ? " " : "",
        country ? " in " : "",
        country ? country : "");

    FreeList free_list = {.list = furi_string_alloc(), .count = 0};
    FuriString* error = furi_string_alloc();
    int status;
    AnswerEnd end =
        board_request(app, GET, url, NULL, NULL, free_list_line, &free_list, &status, error);
    if(end == AnswerCancelled) {
        /* Back was pressed: nothing to show. */
    } else if(end != AnswerDone) {
        report_failure(app, end, error);
    } else if(status >= 400) {
        text_printf(app, false, "hproxy.com answered %d.\n\nTry again in a minute.", status);
    } else if(free_list.count == 0) {
        text_printf(
            app,
            false,
            "hproxy.com has no free proxies like that right now.\n\nTry another country or "
            "protocol.");
    } else {
        app->free_protocol = protocol;
        bool saved = file_write(PATH_FREE, free_list.list);
        text_printf(
            app,
            false,
            "%u free proxies from hproxy.com\n%s\n\n%s",
            (unsigned)free_list.count,
            saved ? "Saved: apps_data/hproxy/free.txt" : "Could not save them to the SD card.",
            furi_string_get_cstr(free_list.list));
    }
    furi_string_free(error);
    furi_string_free(free_list.list);
}

/* ---- checking proxies ----------------------------------------------------------------------- */

typedef struct {
    char (*proxies)[HPROXY_PROXY_MAX];
    bool* answered;
    size_t count;
    size_t batch_start;
    size_t batch_count;
    size_t alive;
    size_t logins;
    size_t invalid;
    FuriString* results; /* two lines per proxy */
    FuriString* alive_list; /* one host:port per line */
} Check;

static void check_line(const char* line, void* context) {
    Check* check = context;
    HproxyResult result;
    if(hproxy_parse_check_row(line, &result) != HproxyRowResult) return;
    for(size_t i = check->batch_start; i < check->batch_start + check->batch_count; i++) {
        if(check->answered[i] || strcmp(check->proxies[i], result.input) != 0) continue;
        check->answered[i] = true;
        char shown[128];
        hproxy_format_result(&result, shown, sizeof(shown));
        furi_string_cat_str(check->results, shown);
        if(result.alive) {
            check->alive++;
            furi_string_cat_printf(check->alive_list, "%s\n", result.input);
        }
        return;
    }
}

/* The proxies in a list file, at most CHECK_MAX; logins and other lines are only counted. */
static void check_read(Check* check, FuriString* text) {
    const char* p = furi_string_get_cstr(text);
    while(*p && check->count < CHECK_MAX) {
        const char* newline = strchr(p, '\n');
        size_t len = newline ? (size_t)(newline - p) : strlen(p);
        char line[HPROXY_PROXY_MAX + 40];
        if(len >= sizeof(line)) {
            /* Too long to be one of ours; a login in it is still a login. */
            if(memchr(p, '@', len)) {
                check->logins++;
            } else {
                check->invalid++;
            }
        } else {
            memcpy(line, p, len);
            line[len] = '\0';
            switch(hproxy_proxy_from_line(line, check->proxies[check->count], HPROXY_PROXY_MAX)) {
            case HproxyLineProxy:
                check->count++;
                break;
            case HproxyLineLogin:
                check->logins++;
                break;
            case HproxyLineInvalid:
                check->invalid++;
                break;
            default:
                break;
            }
        }
        p += len;
        if(*p == '\n') p++;
    }
}

static void job_check(App* app, const char* path, bool mine, const char* protocol) {
    Check check = {0};
    check.proxies = malloc(sizeof(*check.proxies) * CHECK_MAX);
    check.answered = malloc(sizeof(bool) * CHECK_MAX);
    memset(check.answered, 0, sizeof(bool) * CHECK_MAX);
    check.results = furi_string_alloc();
    check.alive_list = furi_string_alloc();
    FuriString* text = furi_string_alloc();
    FuriString* error = furi_string_alloc();

    bool found = file_read(path, text, LIST_READ_MAX);
    if(found) check_read(&check, text);

    if(!found) {
        text_printf(
            app,
            false,
            mine ? "There is no list yet.\n\nPut your proxies on the SD card as "
                   "apps_data/hproxy/proxies.txt, one host:port per line."
                 : "There is no free list yet.\n\nGet one first: Free proxies, then Get the "
                   "list.");
    } else if(check.count == 0) {
        text_printf(app, false, "Nothing to check in this list.");
        if(check.logins) {
            text_printf(
                app,
                true,
                "\n\n%u lines carry a login. They stay on your Flipper and are never sent.",
                (unsigned)check.logins);
        }
        if(check.invalid) {
            text_printf(
                app,
                true,
                "\n\n%u lines are not host:port and were left out.",
                (unsigned)check.invalid);
        }
    } else {
        size_t start = 0;
        bool stopped = false;
        while(start < check.count && !app->cancel) {
            text_printf(
                app,
                false,
                "Checking %u of %u through hproxy.com...\n\n%s",
                (unsigned)(start + 1),
                (unsigned)check.count,
                furi_string_get_cstr(check.results));

            const char* batch[HPROXY_BATCH_MAX];
            size_t n = 0;
            for(size_t i = start; i < check.count && n < HPROXY_BATCH_MAX; i++) {
                batch[n++] = check.proxies[i];
            }
            char payload[HPROXY_BOARD_COMMAND_MAX];
            size_t packed = hproxy_check_payload(payload, sizeof(payload), batch, n, protocol);
            if(packed == 0) {
                /* One proxy too long for the board's request on its own. */
                check.invalid++;
                start++;
                continue;
            }
            check.batch_start = start;
            check.batch_count = packed;

            int status = -1;
            AnswerEnd end = AnswerFailed;
            for(int attempt = 0; attempt < 2 && !app->cancel; attempt++) {
                end = board_request(
                    app,
                    POST,
                    HPROXY_CHECK_URL,
                    HPROXY_POST_HEADERS,
                    payload,
                    check_line,
                    &check,
                    &status,
                    error);
                if(end == AnswerDone && status == 429 && attempt == 0) {
                    text_printf(app, true, "\nhproxy.com asks for a short pause...");
                    pause_ms(app, RATE_PAUSE_MS);
                    continue;
                }
                break;
            }
            if(end == AnswerCancelled || app->cancel) break;
            if(end != AnswerDone) {
                report_failure(app, end, error);
                stopped = true;
                break;
            }
            if(status >= 400) {
                text_printf(
                    app, false, "hproxy.com answered %d.\n\nTry again in a minute.", status);
                stopped = true;
                break;
            }
            /* The board ends an answer after 2 seconds without data: a proxy that had not
             * answered by then is shown as such. */
            for(size_t i = start; i < start + packed; i++) {
                if(!check.answered[i]) {
                    furi_string_cat_printf(
                        check.results, "? %s\n  no answer in time\n", check.proxies[i]);
                }
            }
            start += packed;
        }

        if(!app->cancel && !stopped) {
            bool saved = file_write(PATH_ALIVE, check.alive_list);
            text_printf(
                app,
                false,
                "%u of %u answered\n%s",
                (unsigned)check.alive,
                (unsigned)check.count,
                check.alive ? (saved ? "Saved: apps_data/hproxy/alive.txt" :
                                       "Could not save them to the SD card.") :
                              "");
            if(check.logins) {
                text_printf(
                    app,
                    true,
                    "\n%u lines with a login stayed on your Flipper.",
                    (unsigned)check.logins);
            }
            if(check.invalid) {
                text_printf(
                    app, true, "\n%u lines were not host:port.", (unsigned)check.invalid);
            }
            text_printf(app, true, "\n\n%s", furi_string_get_cstr(check.results));
        }
    }

    furi_string_free(error);
    furi_string_free(text);
    furi_string_free(check.alive_list);
    furi_string_free(check.results);
    free(check.answered);
    free(check.proxies);
}

/* ---- the worker ------------------------------------------------------------------------------ */

static int32_t worker_main(void* context) {
    App* app = context;
    BoardState board = board_check(app);
    if(app->cancel) {
        /* Back was pressed. */
    } else if(board != BoardReady) {
        text_printf(app, false, "%s", board_problem(board));
    } else {
        switch(app->job) {
        case JobFreeList:
            job_free_list(app);
            break;
        case JobCheckMine:
            job_check(app, PATH_MINE, true, NULL);
            break;
        case JobCheckFree:
            job_check(app, PATH_FREE, false, app->free_protocol);
            break;
        }
    }
    view_dispatcher_send_custom_event(app->view_dispatcher, EventDone);
    return 0;
}

static void job_start(App* app, Job job, ViewId back) {
    if(app->worker) return; /* the last one is still finishing */
    app->job = job;
    app->cancel = false;
    app->text_back = back;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    furi_string_set_str(app->work_text, "Asking the WiFi board...");
    furi_mutex_release(app->mutex);
    show_update(app);
    text_box_set_focus(app->text_box, TextBoxFocusStart);
    view_switch(app, ViewText);
    app->worker = furi_thread_alloc_ex("HProxyWorker", WORKER_STACK, worker_main, app);
    furi_thread_start(app->worker);
}

/* ---- the screens ---------------------------------------------------------------------------- */

static void show_static(App* app, const char* text) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    furi_string_set_str(app->work_text, text);
    furi_mutex_release(app->mutex);
    app->text_back = ViewMenu;
    show_update(app);
    text_box_set_focus(app->text_box, TextBoxFocusStart);
    view_switch(app, ViewText);
}

static void on_menu(void* context, uint32_t index) {
    App* app = context;
    switch(index) {
    case MenuFree:
        view_switch(app, ViewFree);
        break;
    case MenuCheckMine:
        job_start(app, JobCheckMine, ViewMenu);
        break;
    case MenuCheckFree:
        job_start(app, JobCheckFree, ViewMenu);
        break;
    case MenuSetup:
        show_static(app, SETUP_TEXT);
        break;
    default:
        break;
    }
}

static void on_protocol(VariableItem* item) {
    App* app = variable_item_get_context(item);
    app->protocol_index = variable_item_get_current_value_index(item);
    variable_item_set_current_value_text(item, PROTOCOL_NAMES[app->protocol_index]);
}

static void on_country(VariableItem* item) {
    App* app = variable_item_get_context(item);
    app->country_index = variable_item_get_current_value_index(item);
    variable_item_set_current_value_text(item, COUNTRIES[app->country_index]);
}

static void on_count(VariableItem* item) {
    App* app = variable_item_get_context(item);
    app->count_index = variable_item_get_current_value_index(item);
    variable_item_set_current_value_text(item, COUNT_NAMES[app->count_index]);
}

static void on_free_enter(void* context, uint32_t index) {
    App* app = context;
    if(index == 3) job_start(app, JobFreeList, ViewFree);
}

static bool on_custom_event(void* context, uint32_t event) {
    App* app = context;
    if(event != EventUpdate && event != EventDone) return false;
    if(app->view == ViewText) show_update(app);
    if(event == EventDone && app->worker) {
        furi_thread_join(app->worker);
        furi_thread_free(app->worker);
        app->worker = NULL;
    }
    return true;
}

static bool on_back(void* context) {
    App* app = context;
    switch(app->view) {
    case ViewText:
        if(app->worker) app->cancel = true;
        view_switch(app, app->text_back);
        return true;
    case ViewFree:
        view_switch(app, ViewMenu);
        return true;
    default:
        return false; /* the menu: leave the app */
    }
}

static VariableItem* add_choice(
    VariableItemList* list,
    const char* label,
    const char* const* names,
    uint8_t count,
    uint8_t index,
    VariableItemChangeCallback callback,
    App* app) {
    VariableItem* item = variable_item_list_add(list, label, count, callback, app);
    variable_item_set_current_value_index(item, index);
    variable_item_set_current_value_text(item, names[index]);
    return item;
}

static App* app_alloc(void) {
    App* app = malloc(sizeof(App));
    memset(app, 0, sizeof(App));
    app->count_index = 1; /* 10 proxies */
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->work_text = furi_string_alloc();
    app->show_text = furi_string_alloc();
    app->lines = furi_message_queue_alloc(LINE_QUEUE, sizeof(FuriString*));

    /* The expansion module service listens on the GPIO serial port; it steps aside while HProxy
     * talks to the WiFi board there, and comes back when HProxy closes. */
    app->expansion = furi_record_open(RECORD_EXPANSION);
    expansion_disable(app->expansion);
    app->fhttp = flipper_http_alloc();
    if(app->fhttp) {
        app->fhttp->user_rx_line_cb = board_line;
        app->fhttp->user_callback_context = app;
    } else {
        FURI_LOG_E(TAG, "the GPIO serial port could not be opened");
    }

    /* The folder for proxies.txt, so it is there to find on the SD card. */
    Storage* storage = furi_record_open(RECORD_STORAGE);
    storage_simply_mkdir(storage, HPROXY_DIR);
    furi_record_close(RECORD_STORAGE);

    app->gui = furi_record_open(RECORD_GUI);
    app->view_dispatcher = view_dispatcher_alloc();
    view_dispatcher_set_event_callback_context(app->view_dispatcher, app);
    view_dispatcher_set_custom_event_callback(app->view_dispatcher, on_custom_event);
    view_dispatcher_set_navigation_event_callback(app->view_dispatcher, on_back);
    view_dispatcher_attach_to_gui(app->view_dispatcher, app->gui, ViewDispatcherTypeFullscreen);

    app->menu = submenu_alloc();
    submenu_set_header(app->menu, "HProxy");
    submenu_add_item(app->menu, "Free proxies", MenuFree, on_menu, app);
    submenu_add_item(app->menu, "Check my list", MenuCheckMine, on_menu, app);
    submenu_add_item(app->menu, "Check the free list", MenuCheckFree, on_menu, app);
    submenu_add_item(app->menu, "How to set up", MenuSetup, on_menu, app);
    view_dispatcher_add_view(app->view_dispatcher, ViewMenu, submenu_get_view(app->menu));

    app->free_options = variable_item_list_alloc();
    add_choice(
        app->free_options,
        "Protocol",
        PROTOCOL_NAMES,
        (uint8_t)COUNT_OF(PROTOCOL_NAMES),
        app->protocol_index,
        on_protocol,
        app);
    add_choice(
        app->free_options,
        "Country",
        COUNTRIES,
        (uint8_t)COUNT_OF(COUNTRIES),
        app->country_index,
        on_country,
        app);
    add_choice(
        app->free_options,
        "How many",
        COUNT_NAMES,
        (uint8_t)COUNT_OF(COUNT_NAMES),
        app->count_index,
        on_count,
        app);
    variable_item_list_add(app->free_options, "Get the list", 0, NULL, NULL);
    variable_item_list_set_enter_callback(app->free_options, on_free_enter, app);
    view_dispatcher_add_view(
        app->view_dispatcher, ViewFree, variable_item_list_get_view(app->free_options));

    app->text_box = text_box_alloc();
    text_box_set_font(app->text_box, TextBoxFontText);
    view_dispatcher_add_view(app->view_dispatcher, ViewText, text_box_get_view(app->text_box));

    view_switch(app, ViewMenu);
    return app;
}

static void app_free(App* app) {
    if(app->worker) {
        app->cancel = true;
        furi_thread_join(app->worker);
        furi_thread_free(app->worker);
        app->worker = NULL;
    }
    view_dispatcher_remove_view(app->view_dispatcher, ViewMenu);
    view_dispatcher_remove_view(app->view_dispatcher, ViewFree);
    view_dispatcher_remove_view(app->view_dispatcher, ViewText);
    submenu_free(app->menu);
    variable_item_list_free(app->free_options);
    text_box_free(app->text_box);
    view_dispatcher_free(app->view_dispatcher);
    furi_record_close(RECORD_GUI);

    if(app->fhttp) flipper_http_free(app->fhttp);
    lines_clear(app);
    furi_message_queue_free(app->lines);
    expansion_enable(app->expansion);
    furi_record_close(RECORD_EXPANSION);

    furi_string_free(app->show_text);
    furi_string_free(app->work_text);
    furi_mutex_free(app->mutex);
    free(app);
}

int32_t hproxy_app(void* p) {
    UNUSED(p);
    App* app = app_alloc();
    view_dispatcher_run(app->view_dispatcher);
    app_free(app);
    return 0;
}
