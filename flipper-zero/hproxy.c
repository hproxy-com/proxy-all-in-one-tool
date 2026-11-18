/* HProxy for Flipper Zero.
 *
 * Free proxies from hproxy.com and a proxy checker on the Flipper, over the WiFi Devboard (or an
 * ESP32, Pico W or BW16 board) flashed with FlipperHTTP 2.2 or newer:
 * https://github.com/jblanked/FlipperHTTP
 *
 * The board keeps its WiFi networks itself (set up once in the FlipperHTTP app) and joins them
 * when it starts, so this app only asks whether it is online. Every request runs in a worker
 * thread; a progress screen shows how far it got, and Back always stops it.
 *
 * Files in apps_data/hproxy on the SD card:
 *   proxies.txt   your own list, one host:port per line; lines with a login stay on the Flipper
 *   free.txt      the last free list fetched here
 *   alive.txt     the proxies that worked in the last check
 *   settings.txt  the free-list choices, kept between runs
 */
#include <furi.h>
#include <gui/gui.h>
#include <gui/elements.h>
#include <gui/view.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
#include <gui/modules/text_box.h>
#include <gui/modules/variable_item_list.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <expansion/expansion.h>

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <flipper_http/flipper_http.h>
#include "hproxy_api.h"

#define TAG "HProxy"

#define HPROXY_DIR EXT_PATH("apps_data/hproxy")
#define PATH_MINE HPROXY_DIR "/proxies.txt"
#define PATH_FREE HPROXY_DIR "/free.txt"
#define PATH_ALIVE HPROXY_DIR "/alive.txt"
#define PATH_SETTINGS HPROXY_DIR "/settings.txt"

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
    ViewProgress,
    ViewFreeList,
    ViewResults,
    ViewText,
} ViewId;

typedef enum {
    MenuFree,
    MenuCheckMine,
    MenuCheckFree,
    MenuResults,
    MenuSetup,
} MenuIndex;

typedef enum {
    EventJobDone = 1,
} EventId;

typedef enum {
    JobFreeList,
    JobCheckMine,
    JobCheckFree,
} Job;

typedef enum {
    OutcomeNone, /* stopped with Back */
    OutcomeText, /* a message: work_text */
    OutcomeFreeList,
    OutcomeResults,
} Outcome;

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

typedef enum {
    RowPending, /* sent, no answer yet */
    RowAlive,
    RowDead,
    RowSilent, /* no answer inside the board's 2-second window */
} RowState;

typedef struct {
    HproxyResult result; /* result.input is the proxy as read from the list */
    RowState state;
} Row;

typedef struct {
    char title[24];
    char status[48];
    float progress; /* 0 to 1; below 0, no bar */
    uint16_t alive;
    uint16_t dead;
    uint16_t silent;
    bool counters;
} ProgressModel;

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
    "3. Free proxies: pick a protocol, a country and how many, then Get the list. Check them right "
    "from the list.\n"
    "\n"
    "4. Your own list: put it on the SD card as apps_data/hproxy/proxies.txt, one host:port per "
    "line, up to 50. Lines with a login stay on your Flipper: they are never sent.\n"
    "\n"
    "Checks run on hproxy.com, ten proxies at a time, 1.5 seconds per proxy. The ones that work "
    "are saved as apps_data/hproxy/alive.txt.\n"
    "\n"
    "hproxy.com";

typedef struct {
    Gui* gui;
    ViewDispatcher* view_dispatcher;
    NotificationApp* notifications;
    Submenu* menu;
    VariableItemList* free_options;
    View* progress;
    Submenu* free_list_menu;
    Submenu* results_menu;
    TextBox* text_box;
    ViewId view;
    ViewId text_back; /* where Back leads from the text screen */
    ViewId job_back; /* where Back leads from the progress screen */

    Expansion* expansion;
    FlipperHTTP* fhttp; /* NULL when the GPIO serial port could not be opened */
    FuriMessageQueue* lines; /* FuriString* lines from the board's receive thread */

    FuriThread* worker;
    volatile bool cancel;
    Job job;
    Outcome outcome;
    bool pending; /* a job asked for while the last one was still finishing */
    Job pending_job;
    ViewId pending_back;

    FuriMutex* mutex; /* guards what the worker hands to the screens below */
    FuriString* work_text;
    FuriString* free_lines; /* one host:port per line */
    size_t free_count;
    Row* rows;
    size_t row_count;
    bool results_ready; /* rows hold a finished check, the one the results screen shows */

    FuriString* show_text; /* what the text box shows: the GUI thread's own copy */
    char free_title[32];
    char results_title[32];

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

/* The free-list choices, as "protocol=1", "country=3", "count=1" lines. */
static uint8_t setting(const char* text, const char* key, uint8_t limit, uint8_t fallback) {
    const char* p = strstr(text, key);
    if(!p) return fallback;
    long value = strtol(p + strlen(key), NULL, 10);
    return value >= 0 && value < limit ? (uint8_t)value : fallback;
}

static void settings_load(App* app) {
    FuriString* text = furi_string_alloc();
    if(file_read(PATH_SETTINGS, text, 256)) {
        const char* s = furi_string_get_cstr(text);
        app->protocol_index =
            setting(s, "protocol=", (uint8_t)COUNT_OF(PROTOCOL_NAMES), app->protocol_index);
        app->country_index = setting(s, "country=", (uint8_t)COUNT_OF(COUNTRIES), app->country_index);
        app->count_index = setting(s, "count=", (uint8_t)COUNT_OF(COUNTS), app->count_index);
    }
    furi_string_free(text);
}

static void settings_save(App* app) {
    FuriString* text = furi_string_alloc_printf(
        "protocol=%u\ncountry=%u\ncount=%u\n",
        app->protocol_index,
        app->country_index,
        app->count_index);
    file_write(PATH_SETTINGS, text);
    furi_string_free(text);
}

/* ---- what the worker hands over --------------------------------------------------------------- */

/* A message for the text screen, shown when the job ends. */
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
}

/* The progress screen. Its model locks itself, so the worker may change it directly. */
static void progress_set(App* app, const char* title, const char* status, float progress) {
    with_view_model(
        app->progress,
        ProgressModel * model,
        {
            if(title) snprintf(model->title, sizeof(model->title), "%s", title);
            if(status) snprintf(model->status, sizeof(model->status), "%s", status);
            model->progress = progress;
        },
        true);
}

static void progress_reset(App* app, const char* title, const char* status, bool counters) {
    with_view_model(
        app->progress,
        ProgressModel * model,
        {
            snprintf(model->title, sizeof(model->title), "%s", title);
            snprintf(model->status, sizeof(model->status), "%s", status);
            model->progress = -1.0f;
            model->alive = 0;
            model->dead = 0;
            model->silent = 0;
            model->counters = counters;
        },
        true);
}

static void progress_count(App* app, RowState state) {
    with_view_model(
        app->progress,
        ProgressModel * model,
        {
            if(state == RowAlive) model->alive++;
            if(state == RowDead) model->dead++;
            if(state == RowSilent) model->silent++;
        },
        true);
}

static void progress_draw(Canvas* canvas, void* data) {
    ProgressModel* model = data;
    canvas_clear(canvas);
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str_aligned(canvas, 64, 2, AlignCenter, AlignTop, model->title);
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(canvas, 64, 16, AlignCenter, AlignTop, model->status);
    if(model->progress >= 0.0f) {
        elements_progress_bar(canvas, 6, 28, 116, model->progress);
    }
    if(model->counters) {
        char line[40];
        snprintf(
            line,
            sizeof(line),
            "Alive %u   Dead %u   Slow %u",
            (unsigned)model->alive,
            (unsigned)model->dead,
            (unsigned)model->silent);
        canvas_draw_str_aligned(canvas, 64, 43, AlignCenter, AlignTop, line);
    }
    canvas_draw_str_aligned(canvas, 64, 63, AlignCenter, AlignBottom, "Back to stop");
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

    progress_set(app, NULL, "Looking for the WiFi board...", -1.0f);
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

    progress_set(app, NULL, "Is it online?", -1.0f);
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
               "newer, then try again. More in Setup and help.";
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
        /* After Back the answer may still finish, so the next request starts on a quiet line. */
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
        text_printf(
            app, false, "The WiFi board reported a problem:\n\n%s", furi_string_get_cstr(error));
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
    FuriString* list;
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

static Outcome job_free_list(App* app) {
    const char* protocol = PROTOCOL_PARAMS[app->protocol_index];
    const char* country = app->country_index ? COUNTRIES[app->country_index] : NULL;
    unsigned count = COUNTS[app->count_index];
    char url[192];
    if(!hproxy_list_url(url, sizeof(url), protocol, country, count)) {
        text_printf(app, false, "These choices do not make a request.");
        return OutcomeText;
    }

    BoardState board = board_check(app);
    if(app->cancel) return OutcomeNone;
    if(board != BoardReady) {
        text_printf(app, false, "%s", board_problem(board));
        return OutcomeText;
    }

    progress_set(app, NULL, "Asking hproxy.com...", -1.0f);
    FreeList free_list = {.list = furi_string_alloc(), .count = 0};
    FuriString* error = furi_string_alloc();
    int status;
    AnswerEnd end =
        board_request(app, GET, url, NULL, NULL, free_list_line, &free_list, &status, error);
    Outcome outcome = OutcomeText;
    if(end == AnswerCancelled || app->cancel) {
        outcome = OutcomeNone;
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
        file_write(PATH_FREE, free_list.list);
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        furi_string_set(app->free_lines, free_list.list);
        app->free_count = free_list.count;
        snprintf(
            app->free_title,
            sizeof(app->free_title),
            "%u %s%s%s",
            (unsigned)free_list.count,
            protocol ? PROTOCOL_NAMES[app->protocol_index] : "proxies",
            country ? " " : "",
            country ? country : "");
        furi_mutex_release(app->mutex);
        outcome = OutcomeFreeList;
    }
    furi_string_free(error);
    furi_string_free(free_list.list);
    return outcome;
}

/* ---- checking proxies ----------------------------------------------------------------------- */

typedef struct {
    App* app;
    size_t start;
    size_t end;
} Batch;

static void check_line(const char* line, void* context) {
    Batch* batch = context;
    App* app = batch->app;
    HproxyResult result;
    if(hproxy_parse_check_row(line, &result) != HproxyRowResult) return;
    RowState state = RowPending;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    for(size_t i = batch->start; i < batch->end; i++) {
        Row* row = &app->rows[i];
        if(row->state != RowPending || strcmp(row->result.input, result.input) != 0) continue;
        row->result = result;
        row->state = result.alive ? RowAlive : RowDead;
        state = row->state;
        break;
    }
    furi_mutex_release(app->mutex);
    if(state == RowPending) return;
    progress_count(app, state);
    if(state == RowAlive) notification_message(app->notifications, &sequence_blink_green_10);
}

/* The proxies of a list file into the rows, at most CHECK_MAX. */
static size_t check_read(App* app, FuriString* text, size_t* logins, size_t* invalid) {
    size_t count = 0;
    const char* p = furi_string_get_cstr(text);
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    /* The rows are about to change: the results screen has nothing to show until this check ends. */
    app->results_ready = false;
    while(*p && count < CHECK_MAX) {
        const char* newline = strchr(p, '\n');
        size_t len = newline ? (size_t)(newline - p) : strlen(p);
        char line[HPROXY_PROXY_MAX + 40];
        if(len >= sizeof(line)) {
            /* Too long to be one of ours; a login in it is still a login. */
            if(memchr(p, '@', len)) {
                (*logins)++;
            } else {
                (*invalid)++;
            }
        } else {
            memcpy(line, p, len);
            line[len] = '\0';
            char proxy[HPROXY_PROXY_MAX];
            switch(hproxy_proxy_from_line(line, proxy, sizeof(proxy))) {
            case HproxyLineProxy: {
                /* A clean row: nothing of an earlier check stays in it. */
                Row* row = &app->rows[count];
                memset(row, 0, sizeof(*row));
                memcpy(row->result.input, proxy, sizeof(row->result.input));
                row->result.latency_ms = -1;
                row->state = RowPending;
                count++;
                break;
            }
            case HproxyLineLogin:
                (*logins)++;
                break;
            case HproxyLineInvalid:
                (*invalid)++;
                break;
            default:
                break;
            }
        }
        p += len;
        if(*p == '\n') p++;
    }
    app->row_count = count;
    furi_mutex_release(app->mutex);
    return count;
}

static Outcome job_check(App* app, const char* path, bool mine, const char* protocol) {
    /* The list first: a missing one is said at once, without waking the board. */
    FuriString* text = furi_string_alloc();
    size_t logins = 0;
    size_t invalid = 0;
    size_t count = 0;
    bool found = file_read(path, text, LIST_READ_MAX);
    if(found) count = check_read(app, text, &logins, &invalid);
    furi_string_free(text);

    if(!found) {
        text_printf(
            app,
            false,
            mine ? "There is no list yet.\n\nPut your proxies on the SD card as "
                   "apps_data/hproxy/proxies.txt, one host:port per line."
                 : "There is no free list yet.\n\nGet one first: Free proxies, then Get the "
                   "list.");
        return OutcomeText;
    }
    if(count == 0) {
        text_printf(app, false, "Nothing to check in this list.");
        if(logins) {
            text_printf(
                app,
                true,
                "\n\n%u lines carry a login. They stay on your Flipper and are never sent.",
                (unsigned)logins);
        }
        if(invalid) {
            text_printf(
                app, true, "\n\n%u lines are not host:port and were left out.", (unsigned)invalid);
        }
        return OutcomeText;
    }

    BoardState board = board_check(app);
    if(app->cancel) return OutcomeNone;
    if(board != BoardReady) {
        text_printf(app, false, "%s", board_problem(board));
        return OutcomeText;
    }

    progress_reset(app, "Checking proxies", "Sending them to hproxy.com...", true);
    progress_set(app, NULL, NULL, 0.0f);
    FuriString* error = furi_string_alloc();
    Outcome outcome = OutcomeResults;
    size_t start = 0;
    while(start < count && !app->cancel) {
        const char* batch_proxies[HPROXY_BATCH_MAX];
        size_t n = 0;
        for(size_t i = start; i < count && n < HPROXY_BATCH_MAX; i++) {
            batch_proxies[n++] = app->rows[i].result.input;
        }
        char payload[HPROXY_BOARD_COMMAND_MAX];
        size_t packed = hproxy_check_payload(payload, sizeof(payload), batch_proxies, n, protocol);
        if(packed == 0) {
            /* One proxy too long for the board's request on its own. */
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->rows[start].state = RowSilent;
            furi_mutex_release(app->mutex);
            progress_count(app, RowSilent);
            start++;
            continue;
        }

        Batch batch = {.app = app, .start = start, .end = start + packed};
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
                &batch,
                &status,
                error);
            if(end == AnswerDone && status == 429 && attempt == 0) {
                progress_set(app, NULL, "hproxy.com asks for a pause...", -1.0f);
                pause_ms(app, RATE_PAUSE_MS);
                continue;
            }
            break;
        }
        if(end == AnswerCancelled || app->cancel) {
            outcome = OutcomeNone;
            break;
        }
        if(end != AnswerDone) {
            report_failure(app, end, error);
            outcome = OutcomeText;
            break;
        }
        if(status >= 400) {
            text_printf(app, false, "hproxy.com answered %d.\n\nTry again in a minute.", status);
            outcome = OutcomeText;
            break;
        }
        /* The board ends an answer after 2 seconds without data: a proxy that had not answered by
         * then is slow, or dead. */
        for(size_t i = start; i < start + packed; i++) {
            bool silent = false;
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->rows[i].state == RowPending) {
                app->rows[i].state = RowSilent;
                silent = true;
            }
            furi_mutex_release(app->mutex);
            if(silent) progress_count(app, RowSilent);
        }
        start += packed;
        char status_line[48];
        snprintf(
            status_line, sizeof(status_line), "%u of %u checked", (unsigned)start, (unsigned)count);
        progress_set(app, NULL, status_line, (float)start / (float)count);
    }
    furi_string_free(error);

    if(outcome == OutcomeResults) {
        FuriString* alive_list = furi_string_alloc();
        size_t alive = 0;
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        for(size_t i = 0; i < app->row_count; i++) {
            if(app->rows[i].state != RowAlive) continue;
            furi_string_cat_printf(alive_list, "%s\n", app->rows[i].result.input);
            alive++;
        }
        snprintf(
            app->results_title,
            sizeof(app->results_title),
            "%u of %u work",
            (unsigned)alive,
            (unsigned)app->row_count);
        app->results_ready = true;
        furi_mutex_release(app->mutex);
        file_write(PATH_ALIVE, alive_list);
        furi_string_free(alive_list);
    }
    return outcome;
}

/* ---- jobs ------------------------------------------------------------------------------------ */

static int32_t worker_main(void* context) {
    App* app = context;
    Outcome outcome = OutcomeNone;
    switch(app->job) {
    case JobFreeList:
        outcome = job_free_list(app);
        break;
    case JobCheckMine:
        outcome = job_check(app, PATH_MINE, true, NULL);
        break;
    case JobCheckFree:
        outcome = job_check(app, PATH_FREE, false, app->free_protocol);
        break;
    }
    app->outcome = app->cancel ? OutcomeNone : outcome;
    view_dispatcher_send_custom_event(app->view_dispatcher, EventJobDone);
    return 0;
}

static void view_switch(App* app, ViewId view) {
    app->view = view;
    view_dispatcher_switch_to_view(app->view_dispatcher, view);
}

/* GUI side: the text box lets go of the old text before its copy changes. */
static void show_update(App* app) {
    text_box_set_text(app->text_box, "");
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    furi_string_set(app->show_text, app->work_text);
    furi_mutex_release(app->mutex);
    text_box_set_text(app->text_box, furi_string_get_cstr(app->show_text));
}

static void show_text(App* app, const char* text, ViewId back) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    furi_string_set_str(app->work_text, text);
    furi_mutex_release(app->mutex);
    app->text_back = back;
    show_update(app);
    text_box_set_focus(app->text_box, TextBoxFocusStart);
    view_switch(app, ViewText);
}

static void job_start(App* app, Job job, ViewId back) {
    app->job_back = back;
    if(app->worker) {
        /* The last one is still finishing after Back: this one follows it. */
        app->pending = true;
        app->pending_job = job;
        app->pending_back = back;
        progress_reset(app, "One moment", "Finishing the last request...", false);
        view_switch(app, ViewProgress);
        return;
    }
    app->job = job;
    app->cancel = false;
    app->outcome = OutcomeNone;
    if(job == JobFreeList) {
        progress_reset(app, "Free proxies", "Looking for the WiFi board...", false);
    } else {
        progress_reset(app, "Checking proxies", "Reading the list...", false);
    }
    view_switch(app, ViewProgress);
    app->worker = furi_thread_alloc_ex("HProxyWorker", WORKER_STACK, worker_main, app);
    furi_thread_start(app->worker);
}

/* ---- the lists on screen -------------------------------------------------------------------- */

static void on_free_list(void* context, uint32_t index) {
    App* app = context;
    if(index == 0) job_start(app, JobCheckFree, ViewFreeList);
}

static void free_list_build(App* app) {
    submenu_reset(app->free_list_menu);
    submenu_set_header(app->free_list_menu, app->free_title);
    char check[32];
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    snprintf(check, sizeof(check), "Check these %u now", (unsigned)app->free_count);
    submenu_add_item(app->free_list_menu, check, 0, on_free_list, app);
    const char* p = furi_string_get_cstr(app->free_lines);
    uint32_t index = 1;
    while(*p) {
        const char* newline = strchr(p, '\n');
        size_t len = newline ? (size_t)(newline - p) : strlen(p);
        char label[HPROXY_PROXY_MAX];
        if(len > 0 && len < sizeof(label)) {
            memcpy(label, p, len);
            label[len] = '\0';
            submenu_add_item(app->free_list_menu, label, index++, on_free_list, app);
        }
        p += len;
        if(*p == '\n') p++;
    }
    furi_mutex_release(app->mutex);
}

static void on_result(void* context, uint32_t index) {
    App* app = context;
    char detail[320];
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    if(index >= app->row_count) {
        furi_mutex_release(app->mutex);
        return;
    }
    Row* row = &app->rows[index];
    if(row->state == RowAlive || row->state == RowDead) {
        hproxy_result_detail(&row->result, detail, sizeof(detail));
    } else {
        snprintf(
            detail,
            sizeof(detail),
            "%s\n\nNo answer in time: nothing came back within the 2 seconds the WiFi board "
            "waits. Slow, or dead.\n",
            row->result.input);
    }
    furi_mutex_release(app->mutex);
    show_text(app, detail, ViewResults);
}

/* The results: the ones that work first, fastest first; then the slow ones, then the dead. */
static void results_build(App* app) {
    submenu_reset(app->results_menu);
    submenu_set_header(app->results_menu, app->results_title);
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    bool shown[CHECK_MAX] = {false};
    for(;;) {
        size_t best = CHECK_MAX;
        for(size_t i = 0; i < app->row_count; i++) {
            if(shown[i] || app->rows[i].state != RowAlive) continue;
            int32_t latency = app->rows[i].result.latency_ms;
            if(best == CHECK_MAX ||
               (latency >= 0 && (app->rows[best].result.latency_ms < 0 ||
                                 latency < app->rows[best].result.latency_ms))) {
                best = i;
            }
        }
        if(best == CHECK_MAX) break;
        shown[best] = true;
        char label[HPROXY_PROXY_MAX + 4];
        hproxy_result_label(&app->rows[best].result, label, sizeof(label));
        submenu_add_item(app->results_menu, label, (uint32_t)best, on_result, app);
    }
    for(size_t i = 0; i < app->row_count; i++) {
        if(app->rows[i].state != RowSilent && app->rows[i].state != RowPending) continue;
        char label[HPROXY_PROXY_MAX + 4];
        snprintf(label, sizeof(label), "? %s", app->rows[i].result.input);
        submenu_add_item(app->results_menu, label, (uint32_t)i, on_result, app);
    }
    for(size_t i = 0; i < app->row_count; i++) {
        if(app->rows[i].state != RowDead) continue;
        char label[HPROXY_PROXY_MAX + 4];
        hproxy_result_label(&app->rows[i].result, label, sizeof(label));
        submenu_add_item(app->results_menu, label, (uint32_t)i, on_result, app);
    }
    furi_mutex_release(app->mutex);
}

static void job_done(App* app) {
    furi_thread_join(app->worker);
    furi_thread_free(app->worker);
    app->worker = NULL;
    if(app->pending) {
        app->pending = false;
        job_start(app, app->pending_job, app->pending_back);
        return;
    }
    if(app->cancel || app->view != ViewProgress) return; /* left with Back */
    switch(app->outcome) {
    case OutcomeFreeList:
        free_list_build(app);
        view_switch(app, ViewFreeList);
        notification_message(app->notifications, &sequence_success);
        break;
    case OutcomeResults:
        results_build(app);
        view_switch(app, ViewResults);
        notification_message(app->notifications, &sequence_success);
        break;
    case OutcomeText:
        app->text_back = app->job_back;
        show_update(app);
        text_box_set_focus(app->text_box, TextBoxFocusStart);
        view_switch(app, ViewText);
        notification_message(app->notifications, &sequence_error);
        break;
    default:
        view_switch(app, app->job_back);
        break;
    }
}

/* ---- menus and keys ------------------------------------------------------------------------- */

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
    case MenuResults: {
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        bool ready = app->results_ready;
        furi_mutex_release(app->mutex);
        if(ready) {
            view_switch(app, ViewResults);
        } else {
            show_text(
                app,
                "No results yet.\n\nCheck your list or the free list first: the results stay "
                "here until the next check.",
                ViewMenu);
        }
        break;
    }
    case MenuSetup:
        show_text(app, SETUP_TEXT, ViewMenu);
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
    if(index == 3) {
        settings_save(app);
        job_start(app, JobFreeList, ViewFree);
    }
}

static bool on_custom_event(void* context, uint32_t event) {
    App* app = context;
    if(event != EventJobDone) return false;
    if(app->worker) job_done(app);
    return true;
}

static bool on_back(void* context) {
    App* app = context;
    switch(app->view) {
    case ViewFree:
        settings_save(app);
        view_switch(app, ViewMenu);
        return true;
    case ViewProgress:
        app->pending = false;
        if(app->worker) app->cancel = true;
        view_switch(app, app->job_back);
        return true;
    case ViewFreeList:
        view_switch(app, ViewFree);
        return true;
    case ViewResults:
        view_switch(app, ViewMenu);
        return true;
    case ViewText:
        view_switch(app, app->text_back);
        return true;
    default:
        return false; /* the menu: leave the app */
    }
}

/* ---- the app --------------------------------------------------------------------------------- */

static void add_choice(
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
}

static App* app_alloc(void) {
    App* app = malloc(sizeof(App));
    memset(app, 0, sizeof(App));
    app->count_index = 1; /* 10 proxies */
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->work_text = furi_string_alloc();
    app->show_text = furi_string_alloc();
    app->free_lines = furi_string_alloc();
    app->rows = malloc(sizeof(Row) * CHECK_MAX);
    memset(app->rows, 0, sizeof(Row) * CHECK_MAX);
    app->lines = furi_message_queue_alloc(LINE_QUEUE, sizeof(FuriString*));
    app->notifications = furi_record_open(RECORD_NOTIFICATION);

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

    /* The folder for proxies.txt, so it is there to find on the SD card, and the last choices. */
    Storage* storage = furi_record_open(RECORD_STORAGE);
    storage_simply_mkdir(storage, HPROXY_DIR);
    furi_record_close(RECORD_STORAGE);
    settings_load(app);

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
    submenu_add_item(app->menu, "Last results", MenuResults, on_menu, app);
    submenu_add_item(app->menu, "Setup and help", MenuSetup, on_menu, app);
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

    app->progress = view_alloc();
    view_allocate_model(app->progress, ViewModelTypeLocking, sizeof(ProgressModel));
    view_set_draw_callback(app->progress, progress_draw);
    with_view_model(
        app->progress,
        ProgressModel * model,
        {
            memset(model, 0, sizeof(*model));
            model->progress = -1.0f;
        },
        false);
    view_dispatcher_add_view(app->view_dispatcher, ViewProgress, app->progress);

    app->free_list_menu = submenu_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, ViewFreeList, submenu_get_view(app->free_list_menu));

    app->results_menu = submenu_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewResults, submenu_get_view(app->results_menu));

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
    settings_save(app);

    view_dispatcher_remove_view(app->view_dispatcher, ViewMenu);
    view_dispatcher_remove_view(app->view_dispatcher, ViewFree);
    view_dispatcher_remove_view(app->view_dispatcher, ViewProgress);
    view_dispatcher_remove_view(app->view_dispatcher, ViewFreeList);
    view_dispatcher_remove_view(app->view_dispatcher, ViewResults);
    view_dispatcher_remove_view(app->view_dispatcher, ViewText);
    submenu_free(app->menu);
    variable_item_list_free(app->free_options);
    view_free(app->progress);
    submenu_free(app->free_list_menu);
    submenu_free(app->results_menu);
    text_box_free(app->text_box);
    view_dispatcher_free(app->view_dispatcher);
    furi_record_close(RECORD_GUI);

    if(app->fhttp) flipper_http_free(app->fhttp);
    lines_clear(app);
    furi_message_queue_free(app->lines);
    expansion_enable(app->expansion);
    furi_record_close(RECORD_EXPANSION);
    furi_record_close(RECORD_NOTIFICATION);

    free(app->rows);
    furi_string_free(app->free_lines);
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
