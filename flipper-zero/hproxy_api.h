/* hproxy_api: everything HProxy's Flipper app reads, writes and says to hproxy.com and to your
 * connector.
 *
 * Plain C with no Flipper headers, so the same file is tested on any computer
 * (tests/test_hproxy_api.c) before it is built for the Flipper.
 *
 * The WiFi board (FlipperHTTP) takes one request as a single command line of at most 512 bytes:
 * URL, headers and body together. Its answer comes back line by line, mixed with its own lines
 * such as "[GET/SUCCESS]{"Status-Code":200,...}", "[POST/END]" and "[ERROR] ...". hproxy.com's
 * checker answers one JSON object per proxy, one per line, and ends with {"_event":"end"}. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define HPROXY_APP_VERSION "1.1"

#define HPROXY_CHECK_URL "https://hproxy.com/api/free-proxy/check"

/* The headers of a check request, as the JSON object FlipperHTTP expects. (A User-Agent would be
 * wasted bytes: the board's HTTP client always sends its own.) */
#define HPROXY_POST_HEADERS "{\"Content-Type\":\"application/json\"}"

/* FlipperHTTP's command buffer: flipper_http_request() formats into char command[512]. */
#define HPROXY_BOARD_COMMAND_MAX 512

/* Proxies per check request. The board ends an answer after 2 seconds without data, and the
 * checker sends each proxy's line as soon as that proxy is done: ten proxies at a time keep
 * the live ones inside that window, and the request inside the command buffer. */
#define HPROXY_BATCH_MAX 10

/* How long the checker gives each proxy, in milliseconds: short enough that a silent proxy
 * never holds the answer past the board's 2-second window. */
#define HPROXY_CHECK_TIMEOUT_MS 1500

/* The longest proxy line the app keeps, terminating zero included: 127 characters. */
#define HPROXY_LINE_MAX 128

/* The longest link to a list, terminating zero included. */
#define HPROXY_LINK_MAX 256

/* The longest connector address and login, terminating zero included. */
#define HPROXY_ADDRESS_MAX 96
#define HPROXY_LOGIN_MAX 96

/* ---- proxy lines ---------------------------------------------------------------------------
 *
 * One line of a list, in any shape a provider prints, read by the same rules as hproxy.com's
 * checker (proxy_line_parser.rs, parse_endpoint_with_auth): host:port, [ipv6]:port, scheme://...,
 * user:pass@host:port, host:port@user:pass, host:port:user:pass, user:pass:host:port, and the same
 * with commas, bars, tabs or spaces between the parts. The host is an IPv4 or IPv6 address or a
 * gateway name (gate.example.com). A line the app takes is a line the checker reads. */

typedef enum {
    HproxyLineProxy, /* a proxy */
    HproxyLineBlank, /* empty, or a comment starting with # */
    HproxyLineTooLong, /* longer than HPROXY_LINE_MAX - 1 characters */
    HproxyLineInvalid, /* not a proxy line, or a character the Flipper cannot show */
} HproxyLineKind;

typedef struct {
    char line[HPROXY_LINE_MAX]; /* trimmed, tabs as spaces: what is sent, saved and matched */
    uint16_t port;
    uint8_t scheme_len; /* line[0..scheme_len) is the scheme written before "://", or 0 */
    uint8_t host_at; /* the host inside line, an IPv6 address without its brackets */
    uint8_t host_len;
    uint8_t user_at; /* the username and password, when the login reads as one of each */
    uint8_t user_len;
    uint8_t pass_at;
    uint8_t pass_len;
    bool login; /* the line carries more than its address: a login */
    bool pair; /* that login is one username and one password (user_*, pass_*) */
} HproxyProxy;

/* Reads `len` characters of `text` (no terminating zero needed). */
HproxyLineKind hproxy_proxy_parse(const char* text, size_t len, HproxyProxy* out);

/* host:port, with an IPv6 address in brackets. */
size_t hproxy_proxy_address(const HproxyProxy* proxy, char* out, size_t size);

/* What a screen shows, never a password: "203.0.113.24:1080", "socks5 203.0.113.24:1080" when
 * the line names its protocol, "alice@gate.example.com:7777" with a login. */
size_t hproxy_proxy_label(const HproxyProxy* proxy, char* out, size_t size);

/* The same line, written two ways: compares what the checker would read. */
bool hproxy_proxy_same(const HproxyProxy* a, const HproxyProxy* b);

/* ---- check requests ------------------------------------------------------------------------- */

/* The most body bytes a check request may carry inside the board's command buffer. */
size_t hproxy_check_payload_budget(void);

/* The JSON body for one check request, with as many of `lines` (each a HproxyProxy.line) as fit,
 * at most HPROXY_BATCH_MAX. Every protocol is tried: the checker says which ones answered.
 * Returns how many lines went in, 0 when not even the first one fits. */
size_t hproxy_check_payload(char* out, size_t size, const char* const* lines, size_t count);

/* ---- the checker's answer ------------------------------------------------------------------- */

typedef enum {
    HproxyRowResult, /* one proxy's result */
    HproxyRowEnd, /* {"_event":"end",...}: the checker is done */
    HproxyRowOther, /* a blank line, another event, or not a JSON object */
} HproxyRowKind;

typedef struct {
    char input[HPROXY_LINE_MAX]; /* the line as it was sent */
    bool alive;
    int32_t latency_ms; /* -1 when not measured */
    char country[3]; /* "US", or "" */
    char anonymity[16]; /* "elite", "anonymous", "transparent", or "" */
    char status[16]; /* "alive", "dead", "forbidden", "invalid", "unresolved", ..., or "" */
    char failure[16]; /* why it is dead: "refused", "timeout", "bad_status", ..., or "" */
    char protocols[40]; /* "http, https, socks4, socks5", or "" */
} HproxyResult;

HproxyRowKind hproxy_parse_check_row(const char* line, HproxyResult* result);

/* What a result means for the list. */
typedef enum {
    HproxyVerdictWorks,
    HproxyVerdictSlow, /* no answer inside the board's 2-second window */
    HproxyVerdictDead, /* nothing answered, or the name does not resolve */
    HproxyVerdictLocal, /* a private or reserved address: hproxy.com cannot reach it */
    HproxyVerdictUnread, /* the checker could not read the line */
} HproxyVerdict;

/* `answered`: the checker's line for this proxy arrived. */
HproxyVerdict hproxy_verdict(const HproxyResult* result, bool answered);

/* The protocol word of a working proxy: "socks5", "https", "https+socks5", ... */
size_t hproxy_result_tag(const HproxyResult* result, char* out, size_t size);

/* A result as one list line, its word first: "socks5 203.0.113.24:1080", "dead 198.51.100.7:80". */
size_t hproxy_result_label(const HproxyResult* result, bool answered, char* out, size_t size);

/* A result in full, for its own screen. Never the password. */
size_t hproxy_result_detail(const HproxyResult* result, bool answered, char* out, size_t size);

/* A working proxy's line for alive.txt: as it was written, or with the protocol that answered in
 * front (socks5://...) when a bare line would be read as HTTP by other tools. */
size_t hproxy_alive_line(const HproxyResult* result, char* out, size_t size);

/* ---- your connector ------------------------------------------------------------------------
 *
 * The hproxy connector (a computer, a Raspberry Pi, a NAS, the Home Assistant add-on) carries the
 * traffic; the Flipper is its remote, over the connector's own pages (hproxy 0.4.9 and newer):
 * GET /hproxy/status, GET /hproxy/new-ip, GET /hproxy/new-ip?member=N. Each answers one line of
 * JSON with "ok", and "error" when ok is false. */

typedef struct {
    bool ok;
    char error[160];
    char upstream[112]; /* the proxy in use, as the connector shows it: never the password */
    char source[8]; /* "fixed", "list" or "pool" */
    int32_t member; /* for a list: the proxy in use, counted from 1; -1 otherwise */
    int32_t members;
    bool can_rotate;
    uint64_t uptime_seconds;
    uint64_t connections;
    uint64_t active;
    uint64_t bytes_up;
    uint64_t bytes_down;
    char version[16];
} HproxyConnector;

/* False when the line is not one of the connector's answers. */
bool hproxy_parse_connector(const char* line, HproxyConnector* connector);

/* The connector's answer for a screen; `switched` after New IP or a proxy number. */
size_t hproxy_connector_text(const HproxyConnector* connector, bool switched, char* out, size_t size);

/* An address as typed ("192.168.1.20:8080", "http://nas.local:8080/", "192.168.1.20") to
 * "host:port", the port 8080 when none is given. False when it is not one. */
bool hproxy_connector_address(const char* typed, char* out, size_t size);

/* http://<address>/hproxy/<page>, page "status", "new-ip" or "new-ip?member=N". */
bool hproxy_connector_url(const char* address, const char* page, char* out, size_t size);

/* {"Authorization":"Basic ..."} for a login "name:password". False when it is not one. */
bool hproxy_login_headers(const char* login, char* out, size_t size);

/* A link the board can fetch: http:// or https://, no spaces, quotes or backslashes. */
bool hproxy_link_ok(const char* link);

/* ---- settings ------------------------------------------------------------------------------- */

/* The value of `key` in "key=value" lines. False when the key is not there. */
bool hproxy_setting(const char* text, const char* key, char* out, size_t size);

/* ---- the board's own lines ------------------------------------------------------------------ */

bool hproxy_board_line(const char* line); /* "[GET/END]", "[ERROR] ...", "[PONG]", ... */
bool hproxy_board_end(const char* line); /* the answer is complete */
bool hproxy_board_error(const char* line); /* the board reports a failure */
int hproxy_board_status(const char* line); /* the HTTP status of "[GET|POST/SUCCESS]{...}", or -1 */
