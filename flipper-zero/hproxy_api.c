/* hproxy_api: see hproxy_api.h. Plain C, no Flipper headers, no heap. */
#include "hproxy_api.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- small text helpers ------------------------------------------------------------------- */

static bool is_space(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static bool is_digit(char c) {
    return c >= '0' && c <= '9';
}

static bool is_alpha(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

static bool starts_with(const char* text, const char* prefix) {
    return strncmp(text, prefix, strlen(prefix)) == 0;
}

/* ---- the free list --------------------------------------------------------------------------- */

static bool known_protocol(const char* protocol) {
    static const char* const names[] = {"http", "https", "socks4", "socks5"};
    for(size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if(strcmp(protocol, names[i]) == 0) return true;
    }
    return false;
}

bool hproxy_list_url(
    char* out,
    size_t size,
    const char* protocol,
    const char* country,
    unsigned limit) {
    if(!out || size == 0 || limit < 1 || limit > 100) return false;
    if(protocol && !known_protocol(protocol)) return false;
    char cc[3] = "";
    if(country) {
        if(strlen(country) != 2 || !is_alpha(country[0]) || !is_alpha(country[1])) return false;
        /* The API takes it in lower case (the command-line tool sends it so). */
        cc[0] = (char)(country[0] | 0x20);
        cc[1] = (char)(country[1] | 0x20);
    }
    int n = snprintf(out, size, "%s?format=txt&limit=%u", HPROXY_LIST_URL, limit);
    if(n < 0 || (size_t)n >= size) return false;
    if(protocol) {
        int m = snprintf(out + n, size - (size_t)n, "&protocol=%s", protocol);
        if(m < 0 || (size_t)m >= size - (size_t)n) return false;
        n += m;
    }
    if(country) {
        int m = snprintf(out + n, size - (size_t)n, "&country=%s", cc);
        if(m < 0 || (size_t)m >= size - (size_t)n) return false;
    }
    return true;
}

/* ---- proxy lines ------------------------------------------------------------------------------ */

/* The characters a proxy line may hold: a host name or an address, brackets around IPv6, the
 * port, and an optional scheme. Anything else (quotes, spaces, backslashes) is not sent, which
 * also keeps the JSON body free of characters that would need escaping. */
static bool proxy_char(char c) {
    return is_alpha(c) || is_digit(c) || c == '.' || c == '-' || c == '_' || c == ':' ||
           c == '[' || c == ']' || c == '/';
}

static bool valid_port(const char* digits) {
    if(!*digits) return false;
    long port = 0;
    for(const char* p = digits; *p; p++) {
        if(!is_digit(*p)) return false;
        port = port * 10 + (*p - '0');
        if(port > 65535) return false;
    }
    return port >= 1;
}

HproxyLineKind hproxy_proxy_from_line(const char* line, char* out, size_t size) {
    if(!line) return HproxyLineBlank;
    while(is_space(*line))
        line++;
    size_t len = strlen(line);
    while(len > 0 && is_space(line[len - 1]))
        len--;
    if(len == 0 || line[0] == '#') return HproxyLineBlank;

    char text[HPROXY_PROXY_MAX];
    if(len >= sizeof(text)) {
        /* Too long to send; a login hidden in a long line still counts as a login. */
        for(size_t i = 0; i < len; i++) {
            if(line[i] == '@') return HproxyLineLogin;
        }
        return HproxyLineInvalid;
    }
    memcpy(text, line, len);
    text[len] = '\0';

    if(strchr(text, '@')) return HproxyLineLogin;

    /* After an optional scheme: host:port, [ipv6]:port, or host:port:user:pass. */
    const char* rest = strstr(text, "://");
    rest = rest ? rest + 3 : text;
    const char* port;
    if(rest[0] == '[') {
        const char* close = strchr(rest, ']');
        if(!close || close[1] != ':') return HproxyLineInvalid;
        port = close + 2;
        if(strchr(port, ':')) return HproxyLineLogin; /* [ipv6]:port:user:pass */
    } else {
        size_t colons = 0;
        const char* first = NULL;
        for(const char* p = rest; *p; p++) {
            if(*p == ':') {
                if(!first) first = p;
                colons++;
            }
        }
        if(colons == 3) return HproxyLineLogin; /* host:port:user:pass */
        if(colons != 1) return HproxyLineInvalid;
        if(first == rest) return HproxyLineInvalid; /* no host */
        port = first + 1;
    }
    for(const char* p = text; *p; p++) {
        if(!proxy_char(*p)) return HproxyLineInvalid;
    }
    if(!valid_port(port)) return HproxyLineInvalid;
    if(!out || size <= len) return HproxyLineInvalid;
    memcpy(out, text, len + 1);
    return HproxyLineProxy;
}

/* ---- check requests --------------------------------------------------------------------------- */

#define COMMAND_FRAME "[POST/HTTP]{\"url\":\"\",\"headers\":,\"payload\":}"

size_t hproxy_check_payload_budget(void) {
    return (HPROXY_BOARD_COMMAND_MAX - 1) - (sizeof(COMMAND_FRAME) - 1) -
           (sizeof(HPROXY_CHECK_URL) - 1) - (sizeof(HPROXY_POST_HEADERS) - 1);
}

size_t hproxy_check_payload(
    char* out,
    size_t size,
    const char* const* proxies,
    size_t count,
    const char* protocol) {
    if(!out || size == 0 || !proxies) return 0;
    if(protocol && !known_protocol(protocol)) protocol = NULL;

    char tail[96];
    int t = protocol ? snprintf(
                           tail,
                           sizeof(tail),
                           "],\"timeout_ms\":%d,\"retries\":0,\"protocols\":[\"%s\"]}",
                           HPROXY_CHECK_TIMEOUT_MS,
                           protocol) :
                       snprintf(
                           tail,
                           sizeof(tail),
                           "],\"timeout_ms\":%d,\"retries\":0}",
                           HPROXY_CHECK_TIMEOUT_MS);
    if(t < 0 || (size_t)t >= sizeof(tail)) return 0;

    size_t limit = hproxy_check_payload_budget();
    if(limit > size - 1) limit = size - 1;

    static const char head[] = "{\"proxies\":[";
    size_t used = sizeof(head) - 1;
    if(used + (size_t)t > limit) return 0;
    memcpy(out, head, used);

    size_t packed = 0;
    for(size_t i = 0; i < count && packed < HPROXY_BATCH_MAX; i++) {
        size_t len = strlen(proxies[i]);
        size_t need = len + 2 + (packed ? 1 : 0); /* the quotes, and a comma before all but the first */
        if(used + need + (size_t)t > limit) break;
        if(packed) out[used++] = ',';
        out[used++] = '"';
        memcpy(out + used, proxies[i], len);
        used += len;
        out[used++] = '"';
        packed++;
    }
    if(packed == 0) return 0;
    memcpy(out + used, tail, (size_t)t + 1);
    return packed;
}

/* ---- reading the checker's JSON lines ------------------------------------------------------- */

/* A small reader for flat JSON objects, enough for the checker's rows: it walks the members in
 * order and skips whole values (strings with escapes, nested arrays and objects), so a key's
 * name appearing inside some string value never confuses it. */

static const char* skip_space(const char* p) {
    while(is_space(*p))
        p++;
    return p;
}

static const char* skip_string(const char* p) {
    /* p points at the opening quote. */
    p++;
    while(*p && *p != '"') {
        if(*p == '\\' && p[1]) {
            p += 2;
        } else {
            p++;
        }
    }
    return *p == '"' ? p + 1 : NULL;
}

static const char* skip_value(const char* p) {
    p = skip_space(p);
    if(*p == '"') return skip_string(p);
    if(*p == '{' || *p == '[') {
        int depth = 0;
        while(*p) {
            if(*p == '"') {
                p = skip_string(p);
                if(!p) return NULL;
                continue;
            }
            if(*p == '{' || *p == '[') {
                depth++;
            } else if(*p == '}' || *p == ']') {
                depth--;
                if(depth == 0) return p + 1;
            }
            p++;
        }
        return NULL;
    }
    const char* start = p;
    while(*p && *p != ',' && *p != '}' && *p != ']' && !is_space(*p))
        p++;
    return p == start ? NULL : p;
}

/* Where the value of `key` starts in a JSON object, or NULL. */
static const char* json_value(const char* json, const char* key) {
    const char* p = skip_space(json);
    if(*p != '{') return NULL;
    p++;
    size_t key_len = strlen(key);
    for(;;) {
        p = skip_space(p);
        if(*p != '"') return NULL; /* the end of the object, or not an object */
        const char* name = p + 1;
        const char* after = skip_string(p);
        if(!after) return NULL;
        size_t name_len = (size_t)(after - 1 - name);
        p = skip_space(after);
        if(*p != ':') return NULL;
        p = skip_space(p + 1);
        if(name_len == key_len && memcmp(name, key, key_len) == 0) return p;
        p = skip_value(p);
        if(!p) return NULL;
        p = skip_space(p);
        if(*p != ',') return NULL;
        p++;
    }
}

/* A string value, printable ASCII only (the Flipper's fonts have nothing else). */
static bool json_string(const char* v, char* out, size_t size) {
    if(!v || *v != '"' || size == 0) return false;
    size_t n = 0;
    v++;
    while(*v && *v != '"') {
        char c = *v++;
        if(c == '\\') {
            char e = *v++;
            if(e == '\0') return false;
            if(e == 'u') {
                for(int i = 0; i < 4 && *v && *v != '"'; i++)
                    v++;
                c = '?';
            } else if(e == 'n' || e == 'r' || e == 't' || e == 'b' || e == 'f') {
                c = ' ';
            } else {
                c = e;
            }
        }
        if((unsigned char)c < 0x20 || (unsigned char)c >= 0x7f) c = '?';
        if(n + 1 < size) out[n++] = c;
    }
    out[n] = '\0';
    return *v == '"';
}

static bool json_bool(const char* v, bool* out) {
    if(!v) return false;
    if(strncmp(v, "true", 4) == 0) {
        *out = true;
        return true;
    }
    if(strncmp(v, "false", 5) == 0) {
        *out = false;
        return true;
    }
    return false;
}

static bool json_int(const char* v, int32_t* out) {
    if(!v || !(is_digit(*v) || *v == '-')) return false;
    char* end = NULL;
    long x = strtol(v, &end, 10);
    if(end == v) return false;
    if(x > 2000000000L) x = 2000000000L;
    if(x < -1) x = -1;
    *out = (int32_t)x;
    return true;
}

HproxyRowKind hproxy_parse_check_row(const char* line, HproxyResult* result) {
    if(!line || !result) return HproxyRowOther;
    const char* p = skip_space(line);
    if(*p != '{') return HproxyRowOther;

    char event[16];
    if(json_string(json_value(p, "_event"), event, sizeof(event))) {
        return strcmp(event, "end") == 0 ? HproxyRowEnd : HproxyRowOther;
    }

    memset(result, 0, sizeof(*result));
    result->latency_ms = -1;
    if(!json_string(json_value(p, "input"), result->input, sizeof(result->input))) {
        return HproxyRowOther;
    }
    json_bool(json_value(p, "alive"), &result->alive);
    json_int(json_value(p, "latency_ms"), &result->latency_ms);
    if(!json_string(json_value(p, "country_code"), result->country, sizeof(result->country))) {
        result->country[0] = '\0';
    }
    if(!json_string(json_value(p, "anonymity"), result->anonymity, sizeof(result->anonymity))) {
        result->anonymity[0] = '\0';
    }
    if(!json_string(json_value(p, "status"), result->status, sizeof(result->status))) {
        result->status[0] = '\0';
    }
    return HproxyRowResult;
}

size_t hproxy_format_result(const HproxyResult* result, char* out, size_t size) {
    if(!result || !out || size == 0) return 0;
    int n;
    if(result->alive) {
        char details[48] = "";
        size_t d = 0;
        if(result->country[0]) {
            d += (size_t)snprintf(details + d, sizeof(details) - d, "%s", result->country);
        }
        if(result->latency_ms >= 0 && d < sizeof(details)) {
            d += (size_t)snprintf(
                details + d,
                sizeof(details) - d,
                "%s%ldms",
                d ? " " : "",
                (long)result->latency_ms);
        }
        if(result->anonymity[0] && d < sizeof(details)) {
            snprintf(details + d, sizeof(details) - d, "%s%s", d ? " " : "", result->anonymity);
        }
        n = snprintf(out, size, "+ %s\n  %s\n", result->input, details[0] ? details : "alive");
    } else {
        const char* why = strcmp(result->status, "forbidden") == 0 ? "not checkable here" : "dead";
        n = snprintf(out, size, "- %s\n  %s\n", result->input, why);
    }
    if(n < 0) return 0;
    return (size_t)n < size ? (size_t)n : size - 1;
}

/* ---- the board's own lines ------------------------------------------------------------------- */

bool hproxy_board_line(const char* line) {
    /* "[GET/SUCCESS]{...}", "[POST/END]", "[ERROR] ...", "[PONG]": a bracket around capital
     * letters and slashes. A proxy written as [2001:db8::1]:8080 has colons inside instead. */
    if(!line || line[0] != '[') return false;
    const char* p = line + 1;
    if(!(*p >= 'A' && *p <= 'Z')) return false;
    while((*p >= 'A' && *p <= 'Z') || *p == '/' || *p == '_')
        p++;
    return *p == ']';
}

bool hproxy_board_end(const char* line) {
    return line && (starts_with(line, "[GET/END]") || starts_with(line, "[POST/END]"));
}

bool hproxy_board_error(const char* line) {
    return line && starts_with(line, "[ERROR]");
}

int hproxy_board_status(const char* line) {
    if(!line) return -1;
    const char* json;
    if(starts_with(line, "[GET/SUCCESS]")) {
        json = line + strlen("[GET/SUCCESS]");
    } else if(starts_with(line, "[POST/SUCCESS]")) {
        json = line + strlen("[POST/SUCCESS]");
    } else {
        return -1;
    }
    int32_t code = -1;
    if(!json_int(json_value(json, "Status-Code"), &code)) return -1;
    return (int)code;
}
