/* hproxy_api: everything HProxy's Flipper app says to hproxy.com and reads back.
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

#define HPROXY_APP_VERSION "1.0"

#define HPROXY_LIST_URL "https://hproxy.com/api/proxy-list"
#define HPROXY_CHECK_URL "https://hproxy.com/api/free-proxy/check"

/* The headers of a check request, as the JSON object FlipperHTTP expects. A list request needs
 * none. (A User-Agent would be wasted bytes: the board's HTTP client always sends its own.) */
#define HPROXY_POST_HEADERS "{\"Content-Type\":\"application/json\"}"

/* FlipperHTTP's command buffer: flipper_http_request() formats into char command[512]. */
#define HPROXY_BOARD_COMMAND_MAX 512

/* Proxies per check request. The board ends an answer after 2 seconds without data, and the
 * checker sends each proxy's line as soon as that proxy is done: ten proxies at a time keep
 * the live ones inside that window, and the request inside the command buffer. */
#define HPROXY_BATCH_MAX 10

/* How long the checker gives each proxy, in milliseconds. */
#define HPROXY_CHECK_TIMEOUT_MS 1500

/* The longest proxy line the app sends, terminating zero included. */
#define HPROXY_PROXY_MAX 80

typedef enum {
    HproxyLineProxy, /* host:port, [ipv6]:port, or scheme://host:port */
    HproxyLineBlank, /* empty, or a comment starting with # */
    HproxyLineLogin, /* carries a username and password: it stays on the Flipper */
    HproxyLineInvalid, /* anything else */
} HproxyLineKind;

typedef enum {
    HproxyRowResult, /* one proxy's result */
    HproxyRowEnd, /* {"_event":"end",...}: the checker is done */
    HproxyRowOther, /* a blank line, another event, or not a JSON object */
} HproxyRowKind;

typedef struct {
    char input[HPROXY_PROXY_MAX]; /* the proxy as it was sent */
    bool alive;
    int32_t latency_ms; /* -1 when not measured */
    char country[3]; /* "US", or "" */
    char anonymity[16]; /* "elite", "anonymous", "transparent", or "" */
    char status[16]; /* "alive", "dead", "forbidden", ..., or "" */
} HproxyResult;

/* The free list as plain text, one host:port per line. `protocol` is http, https, socks4,
 * socks5 or NULL for any; `country` two letters or NULL; `limit` 1 to 100. False when an
 * argument is out of range or the URL does not fit. */
bool hproxy_list_url(
    char* out,
    size_t size,
    const char* protocol,
    const char* country,
    unsigned limit);

/* One line of a proxy list: copied to `out` (trimmed) when it is a proxy the app may send. */
HproxyLineKind hproxy_proxy_from_line(const char* line, char* out, size_t size);

/* The most body bytes a check request may carry inside the board's command buffer. */
size_t hproxy_check_payload_budget(void);

/* The JSON body for one check request, with as many of `proxies` as fit, at most
 * HPROXY_BATCH_MAX. `protocol` (http, https, socks4, socks5) or NULL tells the checker what to
 * try. Returns how many proxies went in, 0 when not even the first one fits. */
size_t hproxy_check_payload(
    char* out,
    size_t size,
    const char* const* proxies,
    size_t count,
    const char* protocol);

/* One line of the checker's answer. */
HproxyRowKind hproxy_parse_check_row(const char* line, HproxyResult* result);

/* A result as two short lines for the Flipper's screen. Returns the length written. */
size_t hproxy_format_result(const HproxyResult* result, char* out, size_t size);

/* The board's own lines. */
bool hproxy_board_line(const char* line); /* "[GET/END]", "[ERROR] ...", "[PONG]", ... */
bool hproxy_board_end(const char* line); /* the answer is complete */
bool hproxy_board_error(const char* line); /* the board reports a failure */
int hproxy_board_status(const char* line); /* the HTTP status of "[GET|POST/SUCCESS]{...}", or -1 */
