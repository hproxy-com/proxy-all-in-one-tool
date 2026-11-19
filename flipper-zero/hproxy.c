/* HProxy for Flipper Zero.
 *
 * Your own proxies on the Flipper: add any kind (typed, from a link, from a file on the SD card),
 * check them through hproxy.com with every protocol tried, and steer the hproxy connector that
 * carries your traffic (New IP, the proxy in use). Over the WiFi Devboard (or an ESP32, Pico W or
 * BW16 board) flashed with FlipperHTTP 2.2 or newer: https://github.com/jblanked/FlipperHTTP
 *
 * The board keeps its WiFi networks itself (set up once in the FlipperHTTP app) and joins them
 * when it starts, so this app only asks whether it is online. Every request runs in a worker
 * thread; a progress screen shows how far it got, and Back always stops it.
 *
 * Files in apps_data/hproxy on the SD card:
 *   proxies.txt   your list, one proxy per line in any shape; the first 100 are used
 *   proxies.bak   the list as it was before the app last removed lines from it
 *   alive.txt     the proxies that worked in the last check
 *   settings.txt  your choices, the link and the connector, kept between runs
 */
#include <furi.h>
#include <gui/gui.h>
#include <gui/elements.h>
#include <gui/view.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
#include <gui/modules/text_box.h>
#include <gui/modules/variable_item_list.h>
#include <dialogs/dialogs.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <expansion/expansion.h>

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <flipper_http/flipper_http.h>
#include "hproxy_api.h"
#include "keyboard.h"

#define TAG "HProxy"

#define HPROXY_DIR EXT_PATH("apps_data/hproxy")
#define PATH_MINE HPROXY_DIR "/proxies.txt"
#define PATH_MINE_NEW HPROXY_DIR "/proxies.new"
#define PATH_MINE_OLD HPROXY_DIR "/proxies.bak"
#define PATH_ALIVE HPROXY_DIR "/alive.txt"
#define PATH_SETTINGS HPROXY_DIR "/settings.txt"

#define MINE_MAX 100 /* proxies the app keeps and checks */
#define FILE_LINE_MAX 256 /* the longest line read from a file; a longer one is copied whole */
#define LINE_QUEUE 128 /* board lines waiting for the worker */
#define WORKER_STACK (8 * 1024)
#define WAIT_PONG_MS 2000
#define WAIT_STATUS_MS 3000
#define WAIT_SILENCE_MS 25000 /* a request is given up after this long without a line */
#define WAIT_END_MS 3000 /* after Back, how long a running answer may finish */
#define RATE_PAUSE_MS 5000 /* the checker takes 10 requests at once, then one every 5 s */
#define RATE_TRIES 4
#define NUMBER_MAX 100 /* the proxy numbers the connector screen offers */

typedef enum {
    ViewMenu,
    ViewMine,
    ViewProxy,
    ViewResults,
    ViewConnector,
    ViewNumber,
    ViewKeyboard,
    ViewProgress,
    ViewText,
} ViewId;

typedef enum {
    MenuMine,
    MenuResults,
    MenuConnector,
    MenuHelp,
} MenuIndex;

typedef enum {
    MineCheck,
    MineAdd,
    MineLink,
    MineFile,
    MineLogins,
    MineMore,
    MineFirst = 100, /* the proxies, from here on */
} MineIndex;

typedef enum {
    ProxyCheck,
    ProxyRemove,
} ProxyIndex;

typedef enum {
    ResultsLogins = 1000,
    ResultsRemove,
} ResultsIndex;

typedef enum {
    ConnectorNewIp,
    ConnectorStatus,
    ConnectorNumber,
    ConnectorAddress,
    ConnectorLogin,
} ConnectorIndex;

typedef enum {
    KeysProxy,
    KeysLink,
    KeysAddress,
    KeysLogin,
} KeysPurpose;

typedef enum {
    EventJobDone = 1,
} EventId;

typedef enum {
    JobCheckAll,
    JobCheckOne,
    JobLink,
    JobFile,
    JobStatus,
    JobNewIp,
    JobMember,
} Job;

typedef enum {
    OutcomeNone, /* stopped with Back */
    OutcomeProblem, /* a message saying what went wrong: work_text */
    OutcomeReport, /* a message saying what was done: work_text */
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

typedef struct {
    HproxyResult result; /* result.input is the line as it was sent */
    bool answered; /* the checker's line for it arrived */
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

static const char SETUP_TEXT[] =
    "HProxy checks your own proxies and steers the hproxy connector that carries your traffic. "
    "It runs on a WiFi board flashed with FlipperHTTP 2.2 or newer: the WiFi Devboard, or an "
    "ESP32, Pico W or BW16 board.\n"
    "\n"
    "1. Flash FlipperHTTP onto the board: github.com/jblanked/FlipperHTTP\n"
    "\n"
    "2. Set up WiFi once in the FlipperHTTP app. The board remembers it and joins by itself.\n"
    "\n"
    "3. Add your proxies in My proxies, in any shape your provider prints: type one, download a "
    "list from a link, or put a .txt file on the SD card (with qFlipper or the Flipper app) and "
    "pick it. They are kept in apps_data/hproxy/proxies.txt, up to 100.\n"
    "\n"
    "4. Check them: hproxy.com tries HTTP, HTTPS, SOCKS4 and SOCKS5 and says which ones answer. "
    "Lines with a login stay on your Flipper until you switch on Send logins. The ones that work "
    "are saved as apps_data/hproxy/alive.txt.\n"
    "\n"
    "5. My connector: hproxy on a computer, a Raspberry Pi or Home Assistant carries the traffic, "
    "and the Flipper is its remote. Start it so your network can reach it:\n"
    "hproxy connect --file proxies.txt --listen 0.0.0.0:8080 --allow-lan\n"
    "then type that machine's address under My connector. New IP switches it to the next proxy.\n"
    "\n"
    "hproxy.com";

static const char LOGINS_ON_TEXT[] =
    "Send logins: on\n"
    "\n"
    "Lines with a username and password now go to hproxy.com to be checked, over HTTPS.\n"
    "\n"
    "When the WiFi board cannot verify hproxy.com's certificate, it tries again without that "
    "check. On a WiFi someone else runs, a login could then be read on the way. Use this on a "
    "WiFi you trust.";

static const char CONNECTOR_SETUP_TEXT[] =
    "Your connector carries the traffic: hproxy on a computer, a Raspberry Pi, a NAS, or the "
    "HProxy add-on in Home Assistant. The Flipper is its remote.\n"
    "\n"
    "1. Start it so your network can reach it:\n"
    "hproxy connect --file proxies.txt --listen 0.0.0.0:8080 --allow-lan\n"
    "\n"
    "2. Type that machine's address under Address, like 192.168.1.20:8080.\n"
    "\n"
    "New IP then switches it to the next proxy of its list.";

typedef struct {
    Gui* gui;
    ViewDispatcher* view_dispatcher;
    NotificationApp* notifications;
    DialogsApp* dialogs;
    Submenu* menu;
    Submenu* mine_menu;
    Submenu* proxy_menu;
    Submenu* results_menu;
    Submenu* connector_menu;
    VariableItemList* number_list;
    Keyboard* keyboard;
    View* progress;
    TextBox* text_box;
    ViewId view;
    ViewId text_back; /* where Back leads from the text screen */
    ViewId job_back; /* where Back leads from the progress screen */
    ViewId results_back; /* where Back leads from the results */
    ViewId keys_back; /* where Back leads from the keyboard */
    KeysPurpose keys_purpose;

    Expansion* expansion;
    FlipperHTTP* fhttp; /* NULL when the GPIO serial port could not be opened */
    FuriMessageQueue* lines; /* FuriString* lines from the board's receive thread */
    volatile uint32_t lines_lost; /* lines the queue had no room for */

    FuriThread* worker;
    volatile bool cancel;
    Job job;
    Outcome outcome;
    bool pending; /* a job asked for while the last one was still finishing */
    Job pending_job;
    ViewId pending_back;
    bool mine_changed; /* the job added to the list */

    FuriMutex* mutex; /* guards what the worker hands to the screens below */
    FuriString* work_text;
    Row* rows;
    size_t row_count;
    size_t held_logins; /* lines with a login the last check did not send */
    bool results_ready; /* rows hold a finished check, the one the results screen shows */
    bool dead_removed; /* the dead ones of these results are gone from the list */
    char results_title[32];

    FuriString* show_text; /* what the text box shows: the GUI thread's own copy */
    FuriString* import_path; /* the file picked to add from */

    size_t mine_count; /* proxies on the list screen */
    bool mine_more; /* the file holds more than MINE_MAX */
    char one_line[HPROXY_LINE_MAX]; /* the proxy picked on the list */
    char one_label[HPROXY_LINE_MAX + 16];
    char proxy_draft[HPROXY_LINE_MAX]; /* what was typed before Back */

    /* Kept in settings.txt. */
    bool send_logins;
    char link[HPROXY_LINK_MAX];
    char connector[HPROXY_ADDRESS_MAX];
    char connector_login[HPROXY_LOGIN_MAX];
    uint8_t member; /* the proxy number picked for the connector, from 1 */
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

/* Appends lines to a file, on a line of their own when the file does not end with a newline. */
static bool file_append(const char* path, FuriString* lines) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    storage_simply_mkdir(storage, HPROXY_DIR);
    File* file = storage_file_alloc(storage);
    bool ok = false;
    if(storage_file_open(file, path, FSAM_READ_WRITE, FSOM_OPEN_ALWAYS)) {
        uint64_t size = storage_file_size(file);
        bool newline = true;
        if(size > 0 && storage_file_seek(file, (uint32_t)(size - 1), true)) {
            char last = '\n';
            if(storage_file_read(file, &last, 1) == 1) newline = last == '\n';
        }
        ok = storage_file_seek(file, (uint32_t)size, true);
        if(ok && !newline) ok = storage_file_write(file, "\n", 1) == 1;
        size_t n = furi_string_size(lines);
        if(ok) ok = storage_file_write(file, furi_string_get_cstr(lines), n) == n;
    }
    storage_file_close(file);
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return ok;
}

/* Every line of a file, without its line end. A line longer than FILE_LINE_MAX - 1 comes cut,
 * with too_long set. `each` returns false to stop. False when the file is not there. */
typedef bool (*LineEach)(const char* line, size_t len, bool too_long, void* context);

static bool lines_each(const char* path, LineEach each, void* context) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);
    bool found = storage_file_open(file, path, FSAM_READ, FSOM_OPEN_EXISTING);
    if(found) {
        char chunk[128];
        char line[FILE_LINE_MAX];
        size_t len = 0;
        bool too_long = false;
        bool go = true;
        while(go) {
            size_t got = storage_file_read(file, chunk, sizeof(chunk));
            if(got == 0) break;
            for(size_t i = 0; i < got && go; i++) {
                if(chunk[i] == '\n') {
                    line[len] = '\0';
                    go = each(line, len, too_long, context);
                    len = 0;
                    too_long = false;
                } else if(len + 1 < sizeof(line)) {
                    line[len++] = chunk[i];
                } else {
                    too_long = true;
                }
            }
        }
        if(go && (len > 0 || too_long)) {
            line[len] = '\0';
            each(line, len, too_long, context);
        }
    }
    storage_file_close(file);
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);
    return found;
}

/* Writes `from` again as `to`, without the lines `drop` names. Every other line stays exactly as
 * it was, a long one too. Returns how many lines were left out, or -1 when it failed. */
typedef bool (*LineDrop)(const char* line, size_t len, void* context);

typedef struct {
    File* file;
    char data[256];
    size_t len;
    bool ok;
} Out;

static void out_put(Out* out, const char* data, size_t len) {
    while(len > 0 && out->ok) {
        size_t room = sizeof(out->data) - out->len;
        size_t n = len < room ? len : room;
        memcpy(out->data + out->len, data, n);
        out->len += n;
        data += n;
        len -= n;
        if(out->len == sizeof(out->data)) {
            out->ok = storage_file_write(out->file, out->data, out->len) == out->len;
            out->len = 0;
        }
    }
}

static int32_t file_filter(const char* from, const char* to, LineDrop drop, void* context) {
    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* in = storage_file_alloc(storage);
    Out out = {.file = storage_file_alloc(storage), .len = 0, .ok = true};
    int32_t dropped = 0;
    if(!storage_file_open(in, from, FSAM_READ, FSOM_OPEN_EXISTING) ||
       !storage_file_open(out.file, to, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        out.ok = false;
    }
    char chunk[128];
    char line[FILE_LINE_MAX];
    size_t len = 0;
    bool through = false; /* a line too long to be a proxy, copied as it comes */
    while(out.ok) {
        size_t got = storage_file_read(in, chunk, sizeof(chunk));
        if(got == 0) break;
        for(size_t i = 0; i < got && out.ok; i++) {
            char c = chunk[i];
            if(through) {
                out_put(&out, &c, 1);
                if(c == '\n') through = false;
            } else if(c == '\n') {
                if(drop(line, len, context)) {
                    dropped++;
                } else {
                    out_put(&out, line, len);
                    out_put(&out, "\n", 1);
                }
                len = 0;
            } else if(len < sizeof(line)) {
                line[len++] = c;
            } else {
                out_put(&out, line, len);
                out_put(&out, &c, 1);
                len = 0;
                through = true;
            }
        }
    }
    if(out.ok && len > 0) {
        if(drop(line, len, context)) {
            dropped++;
        } else {
            out_put(&out, line, len);
        }
    }
    if(out.ok && out.len > 0) out.ok = storage_file_write(out.file, out.data, out.len) == out.len;
    storage_file_close(in);
    storage_file_free(in);
    storage_file_close(out.file);
    storage_file_free(out.file);
    furi_record_close(RECORD_STORAGE);
    return out.ok ? dropped : -1;
}

/* The list without some of its proxies. The list as it was stays as proxies.bak. */
static int32_t mine_remove(LineDrop drop, void* context) {
    int32_t dropped = file_filter(PATH_MINE, PATH_MINE_NEW, drop, context);
    Storage* storage = furi_record_open(RECORD_STORAGE);
    if(dropped > 0) {
        storage_common_remove(storage, PATH_MINE_OLD);
        if(storage_common_rename(storage, PATH_MINE, PATH_MINE_OLD) != FSE_OK) {
            dropped = -1;
        } else if(storage_common_rename(storage, PATH_MINE_NEW, PATH_MINE) != FSE_OK) {
            storage_common_rename(storage, PATH_MINE_OLD, PATH_MINE); /* put it back */
            dropped = -1;
        }
    }
    storage_common_remove(storage, PATH_MINE_NEW);
    furi_record_close(RECORD_STORAGE);
    return dropped;
}

/* ---- settings ------------------------------------------------------------------------------- */

static void settings_load(App* app) {
    FuriString* text = furi_string_alloc();
    if(file_read(PATH_SETTINGS, text, 1024)) {
        const char* s = furi_string_get_cstr(text);
        char value[HPROXY_LINK_MAX];
        if(hproxy_setting(s, "send_logins", value, sizeof(value))) {
            app->send_logins = strcmp(value, "1") == 0;
        }
        if(hproxy_setting(s, "link", value, sizeof(value)) && hproxy_link_ok(value)) {
            snprintf(app->link, sizeof(app->link), "%s", value);
        }
        if(hproxy_setting(s, "connector", value, sizeof(value))) {
            hproxy_connector_address(value, app->connector, sizeof(app->connector));
        }
        if(hproxy_setting(s, "connector_login", value, sizeof(value))) {
            snprintf(app->connector_login, sizeof(app->connector_login), "%s", value);
        }
        if(hproxy_setting(s, "member", value, sizeof(value))) {
            long member = strtol(value, NULL, 10);
            if(member >= 1 && member <= NUMBER_MAX) app->member = (uint8_t)member;
        }
    }
    furi_string_free(text);
}

static void settings_save(App* app) {
    FuriString* text = furi_string_alloc_printf(
        "send_logins=%u\nlink=%s\nconnector=%s\nconnector_login=%s\nmember=%u\n",
        app->send_logins ? 1u : 0u,
        app->link,
        app->connector,
        app->connector_login,
        (unsigned)app->member);
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

static void progress_count(App* app, HproxyVerdict verdict) {
    with_view_model(
        app->progress,
        ProgressModel * model,
        {
            if(verdict == HproxyVerdictWorks) {
                model->alive++;
            } else if(verdict == HproxyVerdictSlow) {
                model->silent++;
            } else {
                model->dead++;
            }
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
            "Work %u   Dead %u   Slow %u",
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
        app->lines_lost++;
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

/* The board, ready for a request; a message and false when it is not. */
static bool board_ready(App* app) {
    BoardState board = board_check(app);
    if(app->cancel) return false;
    if(board != BoardReady) {
        text_printf(app, false, "%s", board_problem(board));
        return false;
    }
    return true;
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

/* ---- adding to the list ------------------------------------------------------------------------ */

/* The list as it is, then each new line: the ones that are proxies the list does not hold yet go
 * in, up to MINE_MAX. */
typedef struct {
    App* app;
    HproxyProxy* known; /* MINE_MAX of them */
    size_t known_count;
    FuriString* added;
    size_t added_count;
    size_t already;
    size_t not_proxies;
    size_t full;
    size_t lines;
} Merge;

static bool merge_known(const char* line, size_t len, bool too_long, void* context) {
    Merge* m = context;
    if(too_long) return true;
    if(m->known_count == MINE_MAX) return false;
    if(hproxy_proxy_parse(line, len, &m->known[m->known_count]) == HproxyLineProxy) {
        m->known_count++;
    }
    return true;
}

static bool merge_open(App* app, Merge* m) {
    memset(m, 0, sizeof(*m));
    m->app = app;
    m->known = malloc(sizeof(HproxyProxy) * MINE_MAX);
    m->added = furi_string_alloc();
    lines_each(PATH_MINE, merge_known, m);
    return true;
}

static void merge_close(Merge* m) {
    free(m->known);
    furi_string_free(m->added);
}

static void merge_line(Merge* m, const char* line, size_t len, bool too_long) {
    m->lines++;
    if(too_long) {
        m->not_proxies++;
        return;
    }
    /* Read straight into the next place on the list: no copy when it goes in. */
    HproxyProxy spare;
    HproxyProxy* proxy = m->known_count < MINE_MAX ? &m->known[m->known_count] : &spare;
    switch(hproxy_proxy_parse(line, len, proxy)) {
    case HproxyLineBlank:
        return;
    case HproxyLineProxy:
        break;
    default:
        m->not_proxies++;
        return;
    }
    for(size_t i = 0; i < m->known_count; i++) {
        if(hproxy_proxy_same(&m->known[i], proxy)) {
            m->already++;
            return;
        }
    }
    if(proxy == &spare) {
        m->full++;
        return;
    }
    m->known_count++;
    furi_string_cat_printf(m->added, "%s\n", proxy->line);
    m->added_count++;
}

/* What the merge did, for the text screen; the new lines are appended to the list. */
static Outcome merge_finish(App* app, Merge* m, const char* source) {
    if(m->added_count && !file_append(PATH_MINE, m->added)) {
        text_printf(app, false, "The list could not be saved on the SD card.");
        return OutcomeProblem;
    }
    if(m->added_count) {
        app->mine_changed = true;
        text_printf(app, false, "Added to your list: %u\n", (unsigned)m->added_count);
    } else {
        text_printf(app, false, "Nothing new in %s.\n", source);
    }
    if(m->already) text_printf(app, true, "\nAlready in it: %u", (unsigned)m->already);
    if(m->not_proxies) text_printf(app, true, "\nNot proxies: %u", (unsigned)m->not_proxies);
    if(m->full) {
        text_printf(
            app, true, "\nDid not fit: %u (the Flipper keeps %u)", (unsigned)m->full, MINE_MAX);
    }
    if(app->lines_lost) {
        text_printf(
            app,
            true,
            "\n\nSome lines were lost on the way, faster than the Flipper could read them. Add "
            "again for the rest.");
    }
    return m->added_count ? OutcomeReport : OutcomeProblem;
}

typedef struct {
    Merge* merge;
    App* app;
} LinkRead;

static void link_line(const char* line, void* context) {
    LinkRead* read = context;
    merge_line(read->merge, line, strlen(line), false);
    if(read->merge->lines % 25 == 0) {
        char status[48];
        snprintf(
            status,
            sizeof(status),
            "%u lines read, %u new",
            (unsigned)read->merge->lines,
            (unsigned)read->merge->added_count);
        progress_set(read->app, NULL, status, -1.0f);
    }
}

static Outcome job_link(App* app) {
    if(!board_ready(app)) return app->cancel ? OutcomeNone : OutcomeProblem;
    progress_set(app, NULL, "Downloading the list...", -1.0f);
    Merge merge;
    merge_open(app, &merge);
    LinkRead read = {.merge = &merge, .app = app};
    FuriString* error = furi_string_alloc();
    int status;
    AnswerEnd end = board_request(app, GET, app->link, NULL, NULL, link_line, &read, &status, error);
    Outcome outcome;
    if(end == AnswerCancelled || app->cancel) {
        outcome = OutcomeNone;
    } else if(end != AnswerDone) {
        report_failure(app, end, error);
        outcome = OutcomeProblem;
    } else if(status >= 400) {
        text_printf(
            app,
            false,
            "The link answered %d.\n\nIs it right, and does it still work in a browser?",
            status);
        outcome = OutcomeProblem;
    } else if(merge.added_count + merge.already + merge.full == 0) {
        text_printf(
            app,
            false,
            "The link answered, but with no proxy lines.\n\nIt should give plain text, one proxy "
            "per line.");
        outcome = OutcomeProblem;
    } else {
        outcome = merge_finish(app, &merge, "this list");
    }
    furi_string_free(error);
    merge_close(&merge);
    return outcome;
}

static bool file_line(const char* line, size_t len, bool too_long, void* context) {
    merge_line(context, line, len, too_long);
    return true;
}

static Outcome job_file(App* app) {
    progress_set(app, NULL, "Reading the file...", -1.0f);
    Merge merge;
    merge_open(app, &merge);
    Outcome outcome;
    if(!lines_each(furi_string_get_cstr(app->import_path), file_line, &merge)) {
        text_printf(app, false, "That file could not be read.");
        outcome = OutcomeProblem;
    } else if(merge.added_count + merge.already + merge.full == 0) {
        text_printf(
            app,
            false,
            "No proxies in that file.\n\nIt should hold one proxy per line, in any shape a "
            "provider prints.");
        outcome = OutcomeProblem;
    } else {
        outcome = merge_finish(app, &merge, "that file");
    }
    merge_close(&merge);
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
    bool matched = false;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    for(size_t i = batch->start; i < batch->end; i++) {
        Row* row = &app->rows[i];
        if(row->answered || strcmp(row->result.input, result.input) != 0) continue;
        row->result = result;
        row->answered = true;
        matched = true;
        break;
    }
    furi_mutex_release(app->mutex);
    if(!matched) return;
    HproxyVerdict verdict = hproxy_verdict(&result, true);
    progress_count(app, verdict);
    if(verdict == HproxyVerdictWorks) {
        notification_message(app->notifications, &sequence_blink_green_10);
    }
}

/* The proxies of the list into the rows: the ones that may be sent, once each, up to MINE_MAX. */
typedef struct {
    App* app;
    size_t count;
    size_t logins;
    size_t not_proxies;
} Collect;

static bool collect_add(Collect* c, const char* line, size_t len, bool too_long) {
    if(too_long) {
        c->not_proxies++;
        return true;
    }
    HproxyProxy proxy;
    switch(hproxy_proxy_parse(line, len, &proxy)) {
    case HproxyLineBlank:
        return true;
    case HproxyLineProxy:
        break;
    default:
        c->not_proxies++;
        return true;
    }
    if(proxy.login && !c->app->send_logins) {
        c->logins++;
        return true;
    }
    if(c->count == MINE_MAX) return false;
    for(size_t i = 0; i < c->count; i++) {
        HproxyProxy seen;
        const char* input = c->app->rows[i].result.input;
        if(hproxy_proxy_parse(input, strlen(input), &seen) == HproxyLineProxy &&
           hproxy_proxy_same(&seen, &proxy)) {
            return true; /* the same proxy twice: checked once */
        }
    }
    Row* row = &c->app->rows[c->count++];
    memset(row, 0, sizeof(*row));
    memcpy(row->result.input, proxy.line, sizeof(row->result.input));
    row->result.latency_ms = -1;
    return true;
}

static bool collect_line(const char* line, size_t len, bool too_long, void* context) {
    return collect_add(context, line, len, too_long);
}

static Outcome job_check(App* app, bool one) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    /* The rows are about to change: the results screen has nothing to show until this check ends. */
    app->results_ready = false;
    furi_mutex_release(app->mutex);

    /* The list first: an empty one is said at once, without waking the board. */
    Collect collect = {.app = app};
    if(one) {
        collect_add(&collect, app->one_line, strlen(app->one_line), false);
    } else {
        lines_each(PATH_MINE, collect_line, &collect);
    }
    size_t count = collect.count;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->row_count = count;
    app->held_logins = collect.logins;
    app->dead_removed = false;
    furi_mutex_release(app->mutex);

    if(count == 0) {
        if(collect.logins) {
            text_printf(
                app,
                false,
                "%s a login, and logins stay on your Flipper.\n\nTo check %s, switch on Send logins "
                "in My proxies.",
                one ? "This proxy carries" : "Every proxy in your list carries",
                one ? "it" : "them");
        } else {
            text_printf(
                app,
                false,
                "Your list is empty.\n\nAdd proxies in My proxies: type one, download a list from "
                "a link, or pick a file.");
        }
        return OutcomeProblem;
    }

    if(!board_ready(app)) return app->cancel ? OutcomeNone : OutcomeProblem;

    progress_reset(app, "Checking proxies", "Sending them to hproxy.com...", true);
    progress_set(app, NULL, NULL, 0.0f);
    FuriString* error = furi_string_alloc();
    Outcome outcome = OutcomeResults;
    size_t start = 0;
    while(start < count && !app->cancel) {
        const char* lines[HPROXY_BATCH_MAX];
        size_t n = 0;
        for(size_t i = start; i < count && n < HPROXY_BATCH_MAX; i++) {
            lines[n++] = app->rows[i].result.input;
        }
        char payload[HPROXY_BOARD_COMMAND_MAX];
        size_t packed = hproxy_check_payload(payload, sizeof(payload), lines, n);
        if(packed == 0) {
            /* A line too long for the board's request on its own: it never went. */
            progress_count(app, HproxyVerdictSlow);
            start++;
            continue;
        }

        Batch batch = {.app = app, .start = start, .end = start + packed};
        int status = -1;
        AnswerEnd end = AnswerFailed;
        for(int attempt = 0; attempt < RATE_TRIES && !app->cancel; attempt++) {
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
            if(end == AnswerDone && status == 429 && attempt + 1 < RATE_TRIES) {
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
            outcome = OutcomeProblem;
            break;
        }
        if(status >= 400) {
            text_printf(app, false, "hproxy.com answered %d.\n\nTry again in a minute.", status);
            outcome = OutcomeProblem;
            break;
        }
        /* The board ends an answer after 2 seconds without data: a proxy that had not answered
         * by then is slow, or dead. */
        for(size_t i = start; i < start + packed; i++) {
            if(!app->rows[i].answered) progress_count(app, HproxyVerdictSlow);
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
            Row* row = &app->rows[i];
            if(hproxy_verdict(&row->result, row->answered) != HproxyVerdictWorks) continue;
            char line[HPROXY_LINE_MAX + 16];
            hproxy_alive_line(&row->result, line, sizeof(line));
            furi_string_cat_printf(alive_list, "%s\n", line);
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

/* ---- your connector -------------------------------------------------------------------------- */

typedef struct {
    HproxyConnector connector;
    bool got;
} ConnectorRead;

static void connector_line(const char* line, void* context) {
    ConnectorRead* read = context;
    if(!read->got && hproxy_parse_connector(line, &read->connector)) read->got = true;
}

static Outcome job_connector(App* app, Job job) {
    if(!app->connector[0]) {
        text_printf(app, false, "%s", CONNECTOR_SETUP_TEXT);
        return OutcomeProblem;
    }
    char page[24];
    if(job == JobMember) {
        snprintf(page, sizeof(page), "new-ip?member=%u", (unsigned)app->member);
    } else {
        snprintf(page, sizeof(page), "%s", job == JobNewIp ? "new-ip" : "status");
    }
    char url[HPROXY_ADDRESS_MAX + 40];
    if(!hproxy_connector_url(app->connector, page, url, sizeof(url))) {
        text_printf(app, false, "The connector's address is too long.");
        return OutcomeProblem;
    }
    char headers[200];
    const char* login = NULL;
    if(app->connector_login[0] && hproxy_login_headers(app->connector_login, headers, sizeof(headers))) {
        login = headers;
    }

    if(!board_ready(app)) return app->cancel ? OutcomeNone : OutcomeProblem;
    progress_set(app, NULL, "Asking your connector...", -1.0f);

    ConnectorRead* read = malloc(sizeof(ConnectorRead));
    memset(read, 0, sizeof(*read));
    FuriString* error = furi_string_alloc();
    int status;
    AnswerEnd end = board_request(app, GET, url, login, NULL, connector_line, read, &status, error);
    Outcome outcome = OutcomeProblem;
    if(end == AnswerCancelled || app->cancel) {
        outcome = OutcomeNone;
    } else if(end != AnswerDone && !read->got) {
        text_printf(
            app,
            false,
            "The WiFi board could not reach your connector at %s.\n\nIs it running, listening for "
            "your network (--listen 0.0.0.0:8080 --allow-lan), on the same WiFi?\n\nThe board "
            "said: %s",
            app->connector,
            end == AnswerSilent ? "nothing" : furi_string_get_cstr(error));
    } else if(status == 401) {
        text_printf(
            app,
            false,
            "Your connector asks for its login.\n\nSet it under Login in My connector, as "
            "name:password.");
    } else if(!read->got) {
        if(status >= 400) {
            text_printf(app, false, "Your connector answered %d.", status);
        } else {
            text_printf(
                app,
                false,
                "Something answered at %s, but not an hproxy connector (0.4.9 or newer).",
                app->connector);
        }
    } else {
        char* shown = malloc(512);
        hproxy_connector_text(&read->connector, job != JobStatus, shown, 512);
        text_printf(app, false, "%s", shown);
        free(shown);
        outcome = read->connector.ok ? OutcomeReport : OutcomeProblem;
    }
    furi_string_free(error);
    free(read);
    return outcome;
}

/* ---- jobs ------------------------------------------------------------------------------------ */

static int32_t worker_main(void* context) {
    App* app = context;
    Outcome outcome = OutcomeNone;
    switch(app->job) {
    case JobCheckAll:
        outcome = job_check(app, false);
        break;
    case JobCheckOne:
        outcome = job_check(app, true);
        break;
    case JobLink:
        outcome = job_link(app);
        break;
    case JobFile:
        outcome = job_file(app);
        break;
    case JobStatus:
    case JobNewIp:
    case JobMember:
        outcome = job_connector(app, app->job);
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
    app->mine_changed = false;
    app->lines_lost = 0;
    switch(job) {
    case JobCheckAll:
    case JobCheckOne:
        progress_reset(app, "Checking proxies", "Reading the list...", false);
        break;
    case JobLink:
        progress_reset(app, "Adding from a link", "Looking for the WiFi board...", false);
        break;
    case JobFile:
        progress_reset(app, "Adding from a file", "Reading the file...", false);
        break;
    default:
        progress_reset(app, "My connector", "Looking for the WiFi board...", false);
        break;
    }
    view_switch(app, ViewProgress);
    app->worker = furi_thread_alloc_ex("HProxyWorker", WORKER_STACK, worker_main, app);
    furi_thread_start(app->worker);
}

/* ---- My proxies ------------------------------------------------------------------------------ */

static void on_mine(void* context, uint32_t index);

typedef struct {
    App* app;
    size_t count;
    bool more;
    bool add; /* the second pass: add the items */
    size_t wanted; /* the proxy whose line is wanted, for pick */
    bool picked;
} MineRead;

static bool mine_read_line(const char* line, size_t len, bool too_long, void* context) {
    MineRead* r = context;
    if(too_long) return true;
    HproxyProxy proxy;
    if(hproxy_proxy_parse(line, len, &proxy) != HproxyLineProxy) return true;
    if(r->count == MINE_MAX) {
        r->more = true;
        return false;
    }
    if(r->add) {
        char label[HPROXY_LINE_MAX + 16];
        hproxy_proxy_label(&proxy, label, sizeof(label));
        submenu_add_item(r->app->mine_menu, label, MineFirst + (uint32_t)r->count, on_mine, r->app);
    } else if(r->wanted == r->count) {
        memcpy(r->app->one_line, proxy.line, sizeof(r->app->one_line));
        hproxy_proxy_label(&proxy, r->app->one_label, sizeof(r->app->one_label));
        r->picked = true;
        return false;
    }
    r->count++;
    return true;
}

static void mine_build(App* app) {
    uint32_t selected = submenu_get_selected_item(app->mine_menu);
    MineRead count = {.app = app, .wanted = SIZE_MAX};
    lines_each(PATH_MINE, mine_read_line, &count);
    app->mine_count = count.count;
    app->mine_more = count.more;

    submenu_reset(app->mine_menu);
    submenu_set_header(app->mine_menu, "My proxies");
    if(count.count) {
        char check[32];
        snprintf(check, sizeof(check), "Check all %u", (unsigned)count.count);
        submenu_add_item(app->mine_menu, check, MineCheck, on_mine, app);
    }
    submenu_add_item(app->mine_menu, "Add one", MineAdd, on_mine, app);
    submenu_add_item(app->mine_menu, "Add from a link", MineLink, on_mine, app);
    submenu_add_item(app->mine_menu, "Add from a file", MineFile, on_mine, app);
    submenu_add_item(
        app->mine_menu,
        app->send_logins ? "Send logins: on" : "Send logins: off",
        MineLogins,
        on_mine,
        app);
    MineRead add = {.app = app, .add = true, .wanted = SIZE_MAX};
    lines_each(PATH_MINE, mine_read_line, &add);
    if(count.more) {
        char more[32];
        snprintf(more, sizeof(more), "Only the first %u are used", MINE_MAX);
        submenu_add_item(app->mine_menu, more, MineMore, on_mine, app);
    }
    submenu_set_selected_item(app->mine_menu, selected);
}

/* The proxy at a place on the list, into one_line and one_label. */
static bool mine_pick(App* app, size_t index) {
    MineRead pick = {.app = app, .wanted = index};
    lines_each(PATH_MINE, mine_read_line, &pick);
    return pick.picked;
}

static bool mine_holds(App* app, const HproxyProxy* proxy) {
    Merge merge;
    merge_open(app, &merge);
    bool found = false;
    for(size_t i = 0; i < merge.known_count && !found; i++) {
        found = hproxy_proxy_same(&merge.known[i], proxy);
    }
    merge_close(&merge);
    return found;
}

static bool confirm(App* app, const char* header, const char* text, const char* yes) {
    DialogMessage* message = dialog_message_alloc();
    dialog_message_set_header(message, header, 64, 2, AlignCenter, AlignTop);
    dialog_message_set_text(message, text, 64, 30, AlignCenter, AlignCenter);
    dialog_message_set_buttons(message, "Cancel", NULL, yes);
    DialogMessageButton button = dialog_message_show(app->dialogs, message);
    dialog_message_free(message);
    return button == DialogMessageButtonRight;
}

static void on_proxy(void* context, uint32_t index);

static void proxy_build(App* app) {
    submenu_reset(app->proxy_menu);
    submenu_set_header(app->proxy_menu, app->one_label);
    submenu_add_item(app->proxy_menu, "Check it", ProxyCheck, on_proxy, app);
    submenu_add_item(app->proxy_menu, "Remove it", ProxyRemove, on_proxy, app);
}

/* ---- the keyboard ------------------------------------------------------------------------------ */

static const char* keys_check(void* context, const char* text) {
    App* app = context;
    switch(app->keys_purpose) {
    case KeysProxy: {
        HproxyProxy proxy;
        switch(hproxy_proxy_parse(text, strlen(text), &proxy)) {
        case HproxyLineBlank:
            return "Type a proxy first";
        case HproxyLineTooLong:
            return "Too long: 127 at most";
        case HproxyLineInvalid:
            return "Not a proxy line";
        case HproxyLineProxy:
            break;
        }
        if(app->mine_count >= MINE_MAX) return "The list is full";
        if(mine_holds(app, &proxy)) return "Already in your list";
        return NULL;
    }
    case KeysLink:
        return hproxy_link_ok(text) ? NULL : "Not an http(s):// link";
    case KeysAddress: {
        char address[HPROXY_ADDRESS_MAX];
        return !text[0] || hproxy_connector_address(text, address, sizeof(address)) ?
                   NULL :
                   "Not an address";
    }
    case KeysLogin:
        return !text[0] || strchr(text, ':') ? NULL : "As name:password";
    }
    return NULL;
}

static void connector_build(App* app);

static void keys_done(void* context, const char* text) {
    App* app = context;
    switch(app->keys_purpose) {
    case KeysProxy: {
        HproxyProxy proxy;
        hproxy_proxy_parse(text, strlen(text), &proxy);
        FuriString* line = furi_string_alloc_printf("%s\n", proxy.line);
        bool saved = file_append(PATH_MINE, line);
        furi_string_free(line);
        if(!saved) {
            show_text(app, "The list could not be saved on the SD card.", ViewMine);
            return;
        }
        app->proxy_draft[0] = '\0';
        mine_build(app);
        view_switch(app, ViewMine);
        notification_message(app->notifications, &sequence_success);
        return;
    }
    case KeysLink:
        snprintf(app->link, sizeof(app->link), "%s", text);
        settings_save(app);
        job_start(app, JobLink, ViewMine);
        return;
    case KeysAddress:
        if(!text[0] || !hproxy_connector_address(text, app->connector, sizeof(app->connector))) {
            app->connector[0] = '\0';
        }
        break;
    case KeysLogin:
        snprintf(app->connector_login, sizeof(app->connector_login), "%s", text);
        break;
    }
    settings_save(app);
    connector_build(app);
    view_switch(app, ViewConnector);
}

static void keys_open(App* app, KeysPurpose purpose) {
    app->keys_purpose = purpose;
    app->keys_back = app->view;
    switch(purpose) {
    case KeysProxy:
        keyboard_setup(
            app->keyboard,
            "A proxy, in any shape",
            app->proxy_draft,
            HPROXY_LINE_MAX - 1,
            keys_check,
            keys_done,
            app);
        break;
    case KeysLink:
        keyboard_setup(
            app->keyboard,
            "Link to a list of proxies",
            app->link[0] ? app->link : "https://",
            HPROXY_LINK_MAX - 1,
            keys_check,
            keys_done,
            app);
        break;
    case KeysAddress:
        keyboard_setup(
            app->keyboard,
            "Connector address",
            app->connector,
            HPROXY_ADDRESS_MAX - 1,
            keys_check,
            keys_done,
            app);
        break;
    case KeysLogin:
        keyboard_setup(
            app->keyboard,
            "Its login, name:password",
            app->connector_login,
            HPROXY_LOGIN_MAX - 1,
            keys_check,
            keys_done,
            app);
        break;
    }
    view_switch(app, ViewKeyboard);
}

/* ---- the results ------------------------------------------------------------------------------- */

static void on_result(void* context, uint32_t index);

/* The results: the ones that work first, fastest first; then the slow, the local, the unread, the
 * dead. */
static void results_build(App* app) {
    uint32_t selected = submenu_get_selected_item(app->results_menu);
    submenu_reset(app->results_menu);
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    submenu_set_header(app->results_menu, app->results_title);
    bool shown[MINE_MAX] = {false};
    char label[HPROXY_LINE_MAX + 24];
    for(;;) {
        size_t best = MINE_MAX;
        for(size_t i = 0; i < app->row_count; i++) {
            Row* row = &app->rows[i];
            if(shown[i] || hproxy_verdict(&row->result, row->answered) != HproxyVerdictWorks) continue;
            int32_t latency = row->result.latency_ms;
            if(best == MINE_MAX ||
               (latency >= 0 && (app->rows[best].result.latency_ms < 0 ||
                                 latency < app->rows[best].result.latency_ms))) {
                best = i;
            }
        }
        if(best == MINE_MAX) break;
        shown[best] = true;
        hproxy_result_label(&app->rows[best].result, true, label, sizeof(label));
        submenu_add_item(app->results_menu, label, (uint32_t)best, on_result, app);
    }
    static const HproxyVerdict after[] = {
        HproxyVerdictSlow, HproxyVerdictLocal, HproxyVerdictUnread, HproxyVerdictDead};
    size_t dead = 0;
    for(size_t v = 0; v < COUNT_OF(after); v++) {
        for(size_t i = 0; i < app->row_count; i++) {
            Row* row = &app->rows[i];
            if(hproxy_verdict(&row->result, row->answered) != after[v]) continue;
            if(after[v] == HproxyVerdictDead) dead++;
            hproxy_result_label(&row->result, row->answered, label, sizeof(label));
            submenu_add_item(app->results_menu, label, (uint32_t)i, on_result, app);
        }
    }
    if(app->held_logins) {
        snprintf(label, sizeof(label), "%u with a login, not sent", (unsigned)app->held_logins);
        submenu_add_item(app->results_menu, label, ResultsLogins, on_result, app);
    }
    if(dead && !app->dead_removed) {
        snprintf(label, sizeof(label), "Remove the %u dead ones", (unsigned)dead);
        submenu_add_item(app->results_menu, label, ResultsRemove, on_result, app);
    }
    furi_mutex_release(app->mutex);
    submenu_set_selected_item(app->results_menu, selected);
}

/* The dead ones of the last check, for mine_remove. */
typedef struct {
    HproxyProxy* dead;
    size_t count;
} DeadOnes;

static bool drop_dead(const char* line, size_t len, void* context) {
    DeadOnes* d = context;
    HproxyProxy proxy;
    if(hproxy_proxy_parse(line, len, &proxy) != HproxyLineProxy) return false;
    for(size_t i = 0; i < d->count; i++) {
        if(hproxy_proxy_same(&proxy, &d->dead[i])) return true;
    }
    return false;
}

static void remove_dead(App* app) {
    DeadOnes d = {.dead = malloc(sizeof(HproxyProxy) * MINE_MAX), .count = 0};
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    for(size_t i = 0; i < app->row_count; i++) {
        Row* row = &app->rows[i];
        if(hproxy_verdict(&row->result, row->answered) != HproxyVerdictDead) continue;
        const char* input = row->result.input;
        if(hproxy_proxy_parse(input, strlen(input), &d.dead[d.count]) == HproxyLineProxy) d.count++;
    }
    furi_mutex_release(app->mutex);
    int32_t removed = mine_remove(drop_dead, &d);
    free(d.dead);
    if(removed < 0) {
        show_text(app, "The list could not be changed on the SD card.", ViewResults);
        return;
    }
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->dead_removed = true;
    furi_mutex_release(app->mutex);
    results_build(app);
    mine_build(app);
    FuriString* text = furi_string_alloc_printf(
        "Removed from your list: %ld\n\nThe list as it was is saved as "
        "apps_data/hproxy/proxies.bak.",
        (long)removed);
    show_text(app, furi_string_get_cstr(text), ViewResults);
    furi_string_free(text);
}

static void on_result(void* context, uint32_t index) {
    App* app = context;
    if(index == ResultsLogins) {
        FuriString* text = furi_string_alloc_printf(
            "Lines with a login: %u\n\nThey stayed on your Flipper and were not checked. To check "
            "them too, switch on Send logins in My proxies.",
            (unsigned)app->held_logins);
        show_text(app, furi_string_get_cstr(text), ViewResults);
        furi_string_free(text);
        return;
    }
    if(index == ResultsRemove) {
        if(confirm(
               app,
               "Remove the dead ones?",
               "They go from proxies.txt.\nThe list as it is now\nis kept as proxies.bak.",
               "Remove")) {
            remove_dead(app);
        }
        return;
    }
    char detail[384];
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    if(index >= app->row_count) {
        furi_mutex_release(app->mutex);
        return;
    }
    Row* row = &app->rows[index];
    hproxy_result_detail(&row->result, row->answered, detail, sizeof(detail));
    furi_mutex_release(app->mutex);
    show_text(app, detail, ViewResults);
}

/* ---- My connector ------------------------------------------------------------------------------ */

static void on_connector(void* context, uint32_t index);

static void connector_build(App* app) {
    uint32_t selected = submenu_get_selected_item(app->connector_menu);
    submenu_reset(app->connector_menu);
    submenu_set_header(app->connector_menu, "My connector");
    submenu_add_item(app->connector_menu, "New IP", ConnectorNewIp, on_connector, app);
    submenu_add_item(app->connector_menu, "What it uses now", ConnectorStatus, on_connector, app);
    submenu_add_item(app->connector_menu, "Use proxy number...", ConnectorNumber, on_connector, app);
    char label[HPROXY_ADDRESS_MAX + 16];
    snprintf(
        label, sizeof(label), "Address: %s", app->connector[0] ? app->connector : "not set yet");
    submenu_add_item(app->connector_menu, label, ConnectorAddress, on_connector, app);
    if(app->connector_login[0]) {
        const char* colon = strchr(app->connector_login, ':');
        int name = colon ? (int)(colon - app->connector_login) : (int)strlen(app->connector_login);
        snprintf(label, sizeof(label), "Login: %.*s", name, app->connector_login);
    } else {
        snprintf(label, sizeof(label), "Login: none");
    }
    submenu_add_item(app->connector_menu, label, ConnectorLogin, on_connector, app);
    submenu_set_selected_item(app->connector_menu, selected);
}

static void on_number(VariableItem* item) {
    App* app = variable_item_get_context(item);
    app->member = (uint8_t)(variable_item_get_current_value_index(item) + 1);
    char text[8];
    snprintf(text, sizeof(text), "%u", (unsigned)app->member);
    variable_item_set_current_value_text(item, text);
}

static void on_number_enter(void* context, uint32_t index) {
    App* app = context;
    if(index == 1) {
        settings_save(app);
        job_start(app, JobMember, ViewNumber);
    }
}

static void on_connector(void* context, uint32_t index) {
    App* app = context;
    switch(index) {
    case ConnectorNewIp:
        job_start(app, JobNewIp, ViewConnector);
        break;
    case ConnectorStatus:
        job_start(app, JobStatus, ViewConnector);
        break;
    case ConnectorNumber: {
        variable_item_list_reset(app->number_list);
        VariableItem* item =
            variable_item_list_add(app->number_list, "Proxy number", NUMBER_MAX, on_number, app);
        variable_item_set_current_value_index(item, (uint8_t)(app->member - 1));
        char text[8];
        snprintf(text, sizeof(text), "%u", (unsigned)app->member);
        variable_item_set_current_value_text(item, text);
        variable_item_list_add(app->number_list, "Switch to it", 0, NULL, NULL);
        variable_item_list_set_enter_callback(app->number_list, on_number_enter, app);
        view_switch(app, ViewNumber);
        break;
    }
    case ConnectorAddress:
        keys_open(app, KeysAddress);
        break;
    case ConnectorLogin:
        keys_open(app, KeysLogin);
        break;
    default:
        break;
    }
}

/* ---- menus and keys ------------------------------------------------------------------------- */

static void on_mine(void* context, uint32_t index) {
    App* app = context;
    if(index >= MineFirst) {
        if(mine_pick(app, index - MineFirst)) {
            proxy_build(app);
            view_switch(app, ViewProxy);
        }
        return;
    }
    switch(index) {
    case MineCheck:
        job_start(app, JobCheckAll, ViewMine);
        break;
    case MineAdd:
        if(app->mine_count >= MINE_MAX) {
            show_text(
                app,
                "Your list is full: the Flipper keeps 100 proxies.\n\nRemove some first, or the "
                "dead ones after a check.",
                ViewMine);
        } else {
            keys_open(app, KeysProxy);
        }
        break;
    case MineLink:
        keys_open(app, KeysLink);
        break;
    case MineFile: {
        DialogsFileBrowserOptions options;
        dialog_file_browser_set_basic_options(&options, ".txt", NULL);
        options.hide_ext = false;
        FuriString* start = furi_string_alloc_set_str(EXT_PATH(""));
        bool picked = dialog_file_browser_show(app->dialogs, app->import_path, start, &options);
        furi_string_free(start);
        if(picked) job_start(app, JobFile, ViewMine);
        break;
    }
    case MineLogins:
        app->send_logins = !app->send_logins;
        settings_save(app);
        submenu_change_item_label(
            app->mine_menu, MineLogins, app->send_logins ? "Send logins: on" : "Send logins: off");
        if(app->send_logins) show_text(app, LOGINS_ON_TEXT, ViewMine);
        break;
    case MineMore: {
        FuriString* text = furi_string_alloc_printf(
            "Your list holds more than %u proxies. The Flipper uses the first %u: checks, "
            "the list here, and what you add.",
            MINE_MAX,
            MINE_MAX);
        show_text(app, furi_string_get_cstr(text), ViewMine);
        furi_string_free(text);
        break;
    }
    default:
        break;
    }
}

static bool drop_one(const char* line, size_t len, void* context) {
    const HproxyProxy* one = context;
    HproxyProxy proxy;
    return hproxy_proxy_parse(line, len, &proxy) == HproxyLineProxy && hproxy_proxy_same(&proxy, one);
}

static void on_proxy(void* context, uint32_t index) {
    App* app = context;
    if(index == ProxyCheck) {
        job_start(app, JobCheckOne, ViewProxy);
        return;
    }
    if(index != ProxyRemove) return;
    if(!confirm(app, "Remove this proxy?", app->one_label, "Remove")) return;
    HproxyProxy* one = malloc(sizeof(HproxyProxy));
    hproxy_proxy_parse(app->one_line, strlen(app->one_line), one);
    int32_t removed = mine_remove(drop_one, one);
    free(one);
    mine_build(app);
    if(removed < 0) {
        show_text(app, "The list could not be changed on the SD card.", ViewMine);
    } else {
        view_switch(app, ViewMine);
    }
}

static void on_menu(void* context, uint32_t index) {
    App* app = context;
    switch(index) {
    case MenuMine:
        mine_build(app);
        view_switch(app, ViewMine);
        break;
    case MenuResults: {
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        bool ready = app->results_ready;
        furi_mutex_release(app->mutex);
        if(ready) {
            app->results_back = ViewMenu;
            view_switch(app, ViewResults);
        } else {
            show_text(
                app,
                "No results yet.\n\nCheck your list in My proxies: the results stay here until "
                "the next check.",
                ViewMenu);
        }
        break;
    }
    case MenuConnector:
        connector_build(app);
        view_switch(app, ViewConnector);
        break;
    case MenuHelp:
        show_text(app, SETUP_TEXT, ViewMenu);
        break;
    default:
        break;
    }
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
    case OutcomeResults:
        app->results_back = app->job_back;
        results_build(app);
        view_switch(app, ViewResults);
        notification_message(app->notifications, &sequence_success);
        break;
    case OutcomeReport:
    case OutcomeProblem:
        if(app->mine_changed) mine_build(app);
        app->text_back = app->job_back;
        show_update(app);
        text_box_set_focus(app->text_box, TextBoxFocusStart);
        view_switch(app, ViewText);
        notification_message(
            app->notifications,
            app->outcome == OutcomeReport ? &sequence_success : &sequence_error);
        break;
    default:
        view_switch(app, app->job_back);
        break;
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
    case ViewMine:
    case ViewConnector:
        view_switch(app, ViewMenu);
        return true;
    case ViewProxy:
        view_switch(app, ViewMine);
        return true;
    case ViewResults:
        if(app->results_back == ViewMine) mine_build(app);
        view_switch(app, app->results_back);
        return true;
    case ViewNumber:
        view_switch(app, ViewConnector);
        return true;
    case ViewKeyboard:
        if(app->keys_purpose == KeysProxy) {
            keyboard_text(app->keyboard, app->proxy_draft, sizeof(app->proxy_draft));
        }
        view_switch(app, app->keys_back);
        return true;
    case ViewProgress:
        app->pending = false;
        if(app->worker) app->cancel = true;
        view_switch(app, app->job_back);
        return true;
    case ViewText:
        if(app->text_back == ViewMine) mine_build(app);
        view_switch(app, app->text_back);
        return true;
    default:
        return false; /* the menu: leave the app */
    }
}

/* ---- the app --------------------------------------------------------------------------------- */

static App* app_alloc(void) {
    App* app = malloc(sizeof(App));
    memset(app, 0, sizeof(App));
    app->member = 1;
    app->results_back = ViewMenu;
    app->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->work_text = furi_string_alloc();
    app->show_text = furi_string_alloc();
    app->import_path = furi_string_alloc();
    app->rows = malloc(sizeof(Row) * MINE_MAX);
    memset(app->rows, 0, sizeof(Row) * MINE_MAX);
    app->lines = furi_message_queue_alloc(LINE_QUEUE, sizeof(FuriString*));
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->dialogs = furi_record_open(RECORD_DIALOGS);

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
    submenu_add_item(app->menu, "My proxies", MenuMine, on_menu, app);
    submenu_add_item(app->menu, "Last results", MenuResults, on_menu, app);
    submenu_add_item(app->menu, "My connector", MenuConnector, on_menu, app);
    submenu_add_item(app->menu, "Setup and help", MenuHelp, on_menu, app);
    view_dispatcher_add_view(app->view_dispatcher, ViewMenu, submenu_get_view(app->menu));

    app->mine_menu = submenu_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewMine, submenu_get_view(app->mine_menu));
    app->proxy_menu = submenu_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewProxy, submenu_get_view(app->proxy_menu));
    app->results_menu = submenu_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewResults, submenu_get_view(app->results_menu));
    app->connector_menu = submenu_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, ViewConnector, submenu_get_view(app->connector_menu));
    app->number_list = variable_item_list_alloc();
    view_dispatcher_add_view(
        app->view_dispatcher, ViewNumber, variable_item_list_get_view(app->number_list));
    app->keyboard = keyboard_alloc();
    view_dispatcher_add_view(app->view_dispatcher, ViewKeyboard, keyboard_get_view(app->keyboard));

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
    view_dispatcher_remove_view(app->view_dispatcher, ViewMine);
    view_dispatcher_remove_view(app->view_dispatcher, ViewProxy);
    view_dispatcher_remove_view(app->view_dispatcher, ViewResults);
    view_dispatcher_remove_view(app->view_dispatcher, ViewConnector);
    view_dispatcher_remove_view(app->view_dispatcher, ViewNumber);
    view_dispatcher_remove_view(app->view_dispatcher, ViewKeyboard);
    view_dispatcher_remove_view(app->view_dispatcher, ViewProgress);
    view_dispatcher_remove_view(app->view_dispatcher, ViewText);
    submenu_free(app->menu);
    submenu_free(app->mine_menu);
    submenu_free(app->proxy_menu);
    submenu_free(app->results_menu);
    submenu_free(app->connector_menu);
    variable_item_list_free(app->number_list);
    keyboard_free(app->keyboard);
    view_free(app->progress);
    text_box_free(app->text_box);
    view_dispatcher_free(app->view_dispatcher);
    furi_record_close(RECORD_GUI);

    if(app->fhttp) flipper_http_free(app->fhttp);
    lines_clear(app);
    furi_message_queue_free(app->lines);
    expansion_enable(app->expansion);
    furi_record_close(RECORD_EXPANSION);
    furi_record_close(RECORD_DIALOGS);
    furi_record_close(RECORD_NOTIFICATION);

    free(app->rows);
    furi_string_free(app->import_path);
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
