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

static bool is_hex(char c) {
    return is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static char lower(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c + ('a' - 'A')) : c;
}

static bool starts_with(const char* text, const char* prefix) {
    return strncmp(text, prefix, strlen(prefix)) == 0;
}

static bool starts_with_nocase(const char* text, const char* prefix) {
    for(; *prefix; text++, prefix++) {
        if(lower(*text) != lower(*prefix)) return false;
    }
    return true;
}

/* The length snprintf wrote, never more than fits. */
static size_t written(int n, size_t size) {
    if(n < 0 || size == 0) return 0;
    return (size_t)n < size ? (size_t)n : size - 1;
}

/* Appends to out[*n], keeping the terminating zero inside `size`. */
static void append(char* out, size_t size, size_t* n, const char* format, const char* text) {
    if(*n + 1 >= size) return;
    *n += written(snprintf(out + *n, size - *n, format, text), size - *n);
}

/* ---- numbers and addresses, by the rules of Rust's standard library -------------------------
 *
 * The checker is written in Rust and reads ports with u16::from_str and addresses with
 * Ipv4Addr::from_str and Ipv6Addr::from_str. These do the same, so the app never sends a line
 * the checker would refuse, and never holds back one it would read. */

/* u16::from_str: an optional '+', then digits; leading zeros are fine. */
static bool parse_u16(const char* s, size_t len, uint16_t* out) {
    size_t i = (len > 0 && s[0] == '+') ? 1 : 0;
    if(i >= len) return false;
    uint32_t value = 0;
    for(; i < len; i++) {
        if(!is_digit(s[i])) return false;
        value = value * 10 + (uint32_t)(s[i] - '0');
        if(value > 65535) return false;
    }
    *out = (uint16_t)value;
    return true;
}

/* An IPv4 address at s[*pos]: four parts of one to three digits, at most 255, no leading zeros. */
static bool read_ipv4(const char* s, size_t len, size_t* pos) {
    size_t p = *pos;
    for(int part = 0; part < 4; part++) {
        if(part > 0) {
            if(p >= len || s[p] != '.') return false;
            p++;
        }
        size_t start = p;
        unsigned value = 0;
        while(p < len && is_digit(s[p]) && p - start < 3) {
            value = value * 10 + (unsigned)(s[p] - '0');
            p++;
        }
        size_t digits = p - start;
        if(digits == 0 || value > 255) return false;
        if(digits > 1 && s[start] == '0') return false;
    }
    *pos = p;
    return true;
}

static bool ipv4_ok(const char* s, size_t len) {
    size_t pos = 0;
    return read_ipv4(s, len, &pos) && pos == len;
}

/* One to four hex digits. */
static bool read_hex_group(const char* s, size_t len, size_t* pos) {
    size_t p = *pos;
    size_t digits = 0;
    while(p < len && is_hex(s[p])) {
        p++;
        if(++digits > 4) return false;
    }
    if(digits == 0) return false;
    *pos = p;
    return true;
}

/* Up to `limit` groups separated by ':', the last two of them maybe an IPv4 address. Returns how
 * many 16-bit groups were read. */
static size_t read_groups(const char* s, size_t len, size_t* pos, size_t limit, bool* ipv4) {
    *ipv4 = false;
    for(size_t i = 0; i < limit; i++) {
        if(i < limit - 1) {
            size_t p = *pos;
            bool separated = i == 0;
            if(!separated && p < len && s[p] == ':') {
                p++;
                separated = true;
            }
            if(separated && read_ipv4(s, len, &p)) {
                *pos = p;
                *ipv4 = true;
                return i + 2;
            }
        }
        size_t p = *pos;
        if(i > 0) {
            if(p >= len || s[p] != ':') return i;
            p++;
        }
        if(!read_hex_group(s, len, &p)) return i;
        *pos = p;
    }
    return limit;
}

static bool ipv6_ok(const char* s, size_t len) {
    size_t pos = 0;
    bool ipv4;
    size_t head = read_groups(s, len, &pos, 8, &ipv4);
    if(head == 8) return pos == len;
    if(ipv4) return false; /* an IPv4 part only ends an address */
    if(pos + 1 >= len || s[pos] != ':' || s[pos + 1] != ':') return false;
    pos += 2;
    read_groups(s, len, &pos, 8 - (head + 1), &ipv4);
    return pos == len;
}

/* A gateway name: dotted labels of letters, digits and '-', and a last label that is not all
 * digits (that is an address with a typo, and resolving it would turn the typo into a lookup). */
static bool is_hostname(const char* s, size_t len) {
    if(len == 0 || len > 253) return false;
    bool dotted = false;
    size_t start = 0;
    for(size_t i = 0; i <= len; i++) {
        if(i < len && s[i] != '.') {
            if(!(is_alpha(s[i]) || is_digit(s[i]) || s[i] == '-')) return false;
            continue;
        }
        size_t n = i - start;
        if(n == 0 || n > 63 || s[start] == '-' || s[i - 1] == '-') return false;
        if(i < len) {
            dotted = true;
        } else {
            bool digits = true;
            for(size_t j = start; j < i; j++) {
                if(!is_digit(s[j])) digits = false;
            }
            if(digits) return false;
        }
        start = i + 1;
    }
    return dotted;
}

static bool dialable(const char* s, size_t len) {
    return ipv4_ok(s, len) || ipv6_ok(s, len) || is_hostname(s, len);
}

/* ---- proxy lines ------------------------------------------------------------------------------ */

typedef struct {
    size_t at;
    size_t len;
} Span;

/* host:port or [ipv6]:port inside line[at .. at+len), trimmed (parse_host_port). */
static bool host_port(const char* line, size_t at, size_t len, Span* host, uint16_t* port) {
    while(len > 0 && is_space(line[at])) {
        at++;
        len--;
    }
    while(len > 0 && is_space(line[at + len - 1]))
        len--;
    if(len == 0) return false;
    const char* s = line + at;
    if(s[0] == '[') {
        const char* close = len > 1 ? memchr(s + 1, ']', len - 1) : NULL;
        if(!close) return false;
        size_t inside = (size_t)(close - (s + 1));
        if(!ipv6_ok(s + 1, inside)) return false;
        size_t rest = inside + 2;
        while(rest < len && s[rest] == ':')
            rest++;
        uint16_t p;
        if(!parse_u16(s + rest, len - rest, &p) || p == 0) return false;
        host->at = at + 1;
        host->len = inside;
        *port = p;
        return true;
    }
    size_t colon = len;
    while(colon > 0 && s[colon - 1] != ':')
        colon--;
    if(colon == 0) return false; /* no ':' */
    uint16_t p;
    if(!parse_u16(s + colon, len - colon, &p) || p == 0) return false;
    if(!dialable(s, colon - 1)) return false;
    host->at = at;
    host->len = colon - 1;
    *port = p;
    return true;
}

/* "user:pass" (split_credentials): false when both halves are empty. */
static bool credentials(const char* line, size_t at, size_t len, Span* user, Span* pass) {
    const char* colon = len ? memchr(line + at, ':', len) : NULL;
    if(colon) {
        user->at = at;
        user->len = (size_t)(colon - (line + at));
        pass->at = user->len + at + 1;
        pass->len = len - user->len - 1;
    } else {
        user->at = at;
        user->len = len;
        pass->at = at + len;
        pass->len = 0;
    }
    return user->len > 0 || pass->len > 0;
}

static const Span NO_SPAN = {0, 0};

static HproxyLineKind found(
    HproxyProxy* out,
    Span host,
    uint16_t port,
    bool login,
    bool pair,
    Span user,
    Span pass) {
    out->host_at = (uint8_t)host.at;
    out->host_len = (uint8_t)host.len;
    out->port = port;
    out->login = login;
    out->pair = pair;
    if(pair) {
        out->user_at = (uint8_t)user.at;
        out->user_len = (uint8_t)user.len;
        out->pass_at = (uint8_t)pass.at;
        out->pass_len = (uint8_t)pass.len;
    }
    return HproxyLineProxy;
}

#define TOKENS_MAX 64 /* a 127-character line holds at most 64 */

static bool token_separator(char c) {
    return c == ':' || c == '@' || c == ',' || c == '|' || c == ' ';
}

HproxyLineKind hproxy_proxy_parse(const char* text, size_t len, HproxyProxy* out) {
    if(!out) return HproxyLineInvalid;
    memset(out, 0, sizeof(*out));
    if(!text) return HproxyLineBlank;
    while(len > 0 && is_space(*text)) {
        text++;
        len--;
    }
    while(len > 0 && is_space(text[len - 1]))
        len--;
    if(len == 0 || text[0] == '#') return HproxyLineBlank;
    if(len >= HPROXY_LINE_MAX) return HproxyLineTooLong;
    for(size_t i = 0; i < len; i++) {
        char c = text[i] == '\t' ? ' ' : text[i];
        /* Printable ASCII only: the Flipper's fonts have nothing else, and the line goes into a
         * JSON string where only quotes and backslashes need escaping. */
        if((unsigned char)c < 0x20 || (unsigned char)c >= 0x7f) return HproxyLineInvalid;
        out->line[i] = c;
    }
    out->line[len] = '\0';
    const char* line = out->line;

    /* The scheme is a hint for people: the checker drops it and tries every protocol. */
    size_t b = 0;
    size_t e = len;
    const char* scheme_end = strstr(line, "://");
    if(scheme_end) {
        size_t k = (size_t)(scheme_end - line);
        b = k + 3;
        bool word = k > 0 && k <= 7;
        for(size_t i = 0; i < k && word; i++) {
            if(!is_alpha(line[i]) && !is_digit(line[i])) word = false;
        }
        if(word) out->scheme_len = (uint8_t)k;
    }
    /* A path after the address goes, before anything else is read. */
    const char* slash = memchr(line + b, '/', e - b);
    if(slash) e = (size_t)(slash - line);
    if(b >= e) return HproxyLineInvalid;

    Span host;
    Span user = NO_SPAN;
    Span pass = NO_SPAN;
    uint16_t port;

    /* creds@host:port, and its mirror host:port@creds, split at the last '@' so a password with
     * '@' in it cannot take the host's place. */
    size_t at = e;
    for(size_t i = e; i > b; i--) {
        if(line[i - 1] == '@') {
            at = i - 1;
            break;
        }
    }
    if(at < e) {
        if(host_port(line, at + 1, e - at - 1, &host, &port)) {
            bool some = credentials(line, b, at - b, &user, &pass);
            return found(out, host, port, some, some, user, pass);
        }
        if(host_port(line, b, at - b, &host, &port)) {
            bool some = credentials(line, at + 1, e - at - 1, &user, &pass);
            return found(out, host, port, some, some, user, pass);
        }
        return HproxyLineInvalid;
    }

    /* [ipv6]:port, maybe followed by :user:pass. */
    if(line[b] == '[') {
        const char* close = memchr(line + b + 1, ']', e - b - 1);
        if(close && ipv6_ok(line + b + 1, (size_t)(close - line) - b - 1)) {
            Span tail[TOKENS_MAX];
            size_t n = 0;
            size_t start = (size_t)(close - line) + 1;
            for(size_t i = start; i <= e && n < TOKENS_MAX; i++) {
                if(i == e || line[i] == ':') {
                    if(i > start) {
                        tail[n].at = start;
                        tail[n].len = i - start;
                        n++;
                    }
                    start = i + 1;
                }
            }
            uint16_t p;
            if(n >= 1 && parse_u16(line + tail[0].at, tail[0].len, &p) && p > 0) {
                host.at = b + 1;
                host.len = (size_t)(close - line) - b - 1;
                bool pair = n == 3;
                return found(
                    out, host, p, n > 1, pair, pair ? tail[1] : NO_SPAN, pair ? tail[2] : NO_SPAN);
            }
        }
    }

    /* An IPv6 address without brackets: v6:port, then v6:port:user:pass. Before the tokenizer,
     * because ':' is both the address's separator and the line's. */
    size_t colons = 0;
    size_t last = 0;
    size_t second = 0;
    for(size_t i = b; i < e; i++) {
        if(line[i] == ':') {
            colons++;
            second = last;
            last = i;
        }
    }
    if(colons >= 2) {
        if(host_port(line, b, e - b, &host, &port) && ipv6_ok(line + host.at, host.len)) {
            return found(out, host, port, false, false, NO_SPAN, NO_SPAN);
        }
        if(colons >= 3 && host_port(line, b, second - b, &host, &port) &&
           ipv6_ok(line + host.at, host.len)) {
            user.at = second + 1;
            user.len = last - second - 1;
            pass.at = last + 1;
            pass.len = e - last - 1;
            return found(out, host, port, true, true, user, pass);
        }
    }

    /* Everything else: the parts between ':', ',', '|' and spaces. An IPv4 address followed by a
     * port first, then a gateway name followed by a port; the two parts left over are the login. */
    Span tokens[TOKENS_MAX];
    size_t n = 0;
    size_t start = b;
    for(size_t i = b; i <= e; i++) {
        if(i == e || token_separator(line[i])) {
            if(i > start) {
                if(n == TOKENS_MAX) return HproxyLineInvalid;
                tokens[n].at = start;
                tokens[n].len = i - start;
                n++;
            }
            start = i + 1;
        }
    }
    for(int pass_kind = 0; pass_kind < 2; pass_kind++) {
        for(size_t i = 0; i + 1 < n; i++) {
            const char* t = line + tokens[i].at;
            bool accepted = pass_kind == 0 ? ipv4_ok(t, tokens[i].len) :
                                             is_hostname(t, tokens[i].len);
            if(!accepted) continue;
            uint16_t p;
            if(!parse_u16(line + tokens[i + 1].at, tokens[i + 1].len, &p) || p == 0) continue;
            /* The parts left over, in their order: a login when there are exactly two. */
            Span left[2] = {NO_SPAN, NO_SPAN};
            size_t rest = 0;
            for(size_t j = 0; j < n; j++) {
                if(j == i || j == i + 1) continue;
                if(rest < 2) left[rest] = tokens[j];
                rest++;
            }
            return found(out, tokens[i], p, rest > 0, rest == 2, left[0], left[1]);
        }
    }
    return HproxyLineInvalid;
}

size_t hproxy_proxy_address(const HproxyProxy* proxy, char* out, size_t size) {
    if(!proxy || !out || size == 0) return 0;
    const char* host = proxy->line + proxy->host_at;
    bool v6 = memchr(host, ':', proxy->host_len) != NULL;
    return written(
        snprintf(
            out,
            size,
            v6 ? "[%.*s]:%u" : "%.*s:%u",
            (int)proxy->host_len,
            host,
            (unsigned)proxy->port),
        size);
}

/* The address with the username in front, or a note that there is a login. */
static size_t masked(const HproxyProxy* proxy, char* out, size_t size) {
    char address[HPROXY_LINE_MAX + 2];
    hproxy_proxy_address(proxy, address, sizeof(address));
    if(proxy->pair && proxy->user_len > 0) {
        return written(
            snprintf(
                out,
                size,
                "%.*s@%s",
                (int)proxy->user_len,
                proxy->line + proxy->user_at,
                address),
            size);
    }
    return written(snprintf(out, size, proxy->login ? "%s (login)" : "%s", address), size);
}

size_t hproxy_proxy_label(const HproxyProxy* proxy, char* out, size_t size) {
    if(!proxy || !out || size == 0) return 0;
    size_t n = 0;
    if(proxy->scheme_len) {
        n = written(snprintf(out, size, "%.*s ", (int)proxy->scheme_len, proxy->line), size);
        for(size_t i = 0; i < n; i++)
            out[i] = lower(out[i]);
    }
    return n + masked(proxy, out + n, size - n);
}

bool hproxy_proxy_same(const HproxyProxy* a, const HproxyProxy* b) {
    if(!a || !b) return false;
    if(a->port != b->port || a->host_len != b->host_len || a->login != b->login) return false;
    for(size_t i = 0; i < a->host_len; i++) {
        if(lower(a->line[a->host_at + i]) != lower(b->line[b->host_at + i])) return false;
    }
    if(!a->login) return true;
    /* A login that is not one username and one password: only the same line is the same. */
    if(!a->pair || !b->pair) return strcmp(a->line, b->line) == 0;
    return a->user_len == b->user_len && a->pass_len == b->pass_len &&
           memcmp(a->line + a->user_at, b->line + b->user_at, a->user_len) == 0 &&
           memcmp(a->line + a->pass_at, b->line + b->pass_at, a->pass_len) == 0;
}

/* ---- check requests --------------------------------------------------------------------------- */

#define COMMAND_FRAME "[POST/HTTP]{\"url\":\"\",\"headers\":,\"payload\":}"

size_t hproxy_check_payload_budget(void) {
    return (HPROXY_BOARD_COMMAND_MAX - 1) - (sizeof(COMMAND_FRAME) - 1) -
           (sizeof(HPROXY_CHECK_URL) - 1) - (sizeof(HPROXY_POST_HEADERS) - 1);
}

/* A line inside a JSON string: quotes and backslashes escaped (a line holds nothing else that
 * would need it). */
static size_t escaped_length(const char* s) {
    size_t n = 0;
    for(; *s; s++)
        n += (*s == '"' || *s == '\\') ? 2 : 1;
    return n;
}

static size_t put_escaped(char* out, const char* s) {
    size_t n = 0;
    for(; *s; s++) {
        if(*s == '"' || *s == '\\') out[n++] = '\\';
        out[n++] = *s;
    }
    return n;
}

size_t hproxy_check_payload(char* out, size_t size, const char* const* lines, size_t count) {
    if(!out || size == 0 || !lines) return 0;

    char tail[64];
    int t = snprintf(tail, sizeof(tail), "],\"timeout_ms\":%d,\"retries\":0}", HPROXY_CHECK_TIMEOUT_MS);
    if(t < 0 || (size_t)t >= sizeof(tail)) return 0;

    size_t limit = hproxy_check_payload_budget();
    if(limit > size - 1) limit = size - 1;

    static const char head[] = "{\"proxies\":[";
    size_t used = sizeof(head) - 1;
    if(used + (size_t)t > limit) return 0;
    memcpy(out, head, used);

    size_t packed = 0;
    for(size_t i = 0; i < count && packed < HPROXY_BATCH_MAX; i++) {
        /* the quotes, and a comma before all but the first */
        size_t need = escaped_length(lines[i]) + 2 + (packed ? 1 : 0);
        if(used + need + (size_t)t > limit) break;
        if(packed) out[used++] = ',';
        out[used++] = '"';
        used += put_escaped(out + used, lines[i]);
        out[used++] = '"';
        packed++;
    }
    if(packed == 0) return 0;
    memcpy(out + used, tail, (size_t)t + 1);
    return packed;
}

/* ---- reading JSON lines ------------------------------------------------------------------------ */

/* A small reader for flat JSON objects, enough for the checker's rows and the connector's answers:
 * it walks the members in order and skips whole values (strings with escapes, nested arrays and
 * objects), so a key's name appearing inside some string value never confuses it. */

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
    if(!json) return NULL;
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

/* The strings of a JSON array, joined with ", " (anything else in it is skipped). */
static bool json_string_array(const char* v, char* out, size_t size) {
    if(!v || *v != '[' || size == 0) return false;
    out[0] = '\0';
    size_t n = 0;
    const char* p = skip_space(v + 1);
    while(*p && *p != ']') {
        if(*p == '"') {
            char item[24];
            if(!json_string(p, item, sizeof(item))) return false;
            /* Whole names only: one that does not fit ends the list, never half of it. */
            size_t need = (n ? 2 : 0) + strlen(item);
            if(n + need >= size) return true;
            snprintf(out + n, size - n, "%s%s", n ? ", " : "", item);
            n += need;
        }
        p = skip_value(p);
        if(!p) return false;
        p = skip_space(p);
        if(*p == ',') p = skip_space(p + 1);
    }
    return *p == ']';
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

static bool json_u64(const char* v, uint64_t* out) {
    if(!v || !is_digit(*v)) return false;
    uint64_t x = 0;
    for(; is_digit(*v); v++) {
        uint64_t digit = (uint64_t)(*v - '0');
        x = x > (UINT64_MAX - digit) / 10 ? UINT64_MAX : x * 10 + digit;
    }
    *out = x;
    return true;
}

/* ---- the checker's answer -------------------------------------------------------------------- */

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
    if(!json_string(json_value(p, "failure"), result->failure, sizeof(result->failure))) {
        result->failure[0] = '\0';
    }
    if(!json_string_array(json_value(p, "protocols"), result->protocols, sizeof(result->protocols))) {
        result->protocols[0] = '\0';
    }
    return HproxyRowResult;
}

HproxyVerdict hproxy_verdict(const HproxyResult* result, bool answered) {
    if(!result || !answered) return HproxyVerdictSlow;
    if(result->alive) return HproxyVerdictWorks;
    if(strcmp(result->status, "forbidden") == 0) return HproxyVerdictLocal;
    if(strcmp(result->status, "invalid") == 0) return HproxyVerdictUnread;
    if(strcmp(result->status, "unchecked") == 0) return HproxyVerdictSlow;
    return HproxyVerdictDead;
}

/* Whether "http, https, socks5" holds `name` as a whole entry. */
static bool has_protocol(const char* list, const char* name) {
    size_t len = strlen(name);
    for(const char* p = list; (p = strstr(p, name)) != NULL; p += len) {
        bool starts = p == list || p[-1] == ' ';
        bool ends = p[len] == '\0' || p[len] == ',';
        if(starts && ends) return true;
    }
    return false;
}

size_t hproxy_result_tag(const HproxyResult* result, char* out, size_t size) {
    if(!result || !out || size == 0) return 0;
    const char* web = has_protocol(result->protocols, "https") ? "https" :
                      has_protocol(result->protocols, "http")  ? "http" :
                                                                 NULL;
    const char* socks = has_protocol(result->protocols, "socks5") ? "socks5" :
                        has_protocol(result->protocols, "socks4") ? "socks4" :
                                                                    NULL;
    if(web && socks) return written(snprintf(out, size, "%s+%s", web, socks), size);
    return written(snprintf(out, size, "%s", web ? web : socks ? socks : "works"), size);
}

/* The proxy a result is about, as a list line shows it. */
static size_t result_address(const HproxyResult* result, char* out, size_t size) {
    HproxyProxy proxy;
    if(hproxy_proxy_parse(result->input, strlen(result->input), &proxy) != HproxyLineProxy) {
        return written(snprintf(out, size, "a line hproxy.com could not read"), size);
    }
    return masked(&proxy, out, size);
}

/* The same for its own screen: the address on one line and the username under it, so neither is
 * broken across lines. */
static size_t result_heading(const HproxyResult* result, char* out, size_t size) {
    HproxyProxy proxy;
    if(hproxy_proxy_parse(result->input, strlen(result->input), &proxy) != HproxyLineProxy) {
        return written(snprintf(out, size, "a line hproxy.com could not read"), size);
    }
    size_t n = hproxy_proxy_address(&proxy, out, size);
    if(proxy.pair && proxy.user_len > 0 && n + 1 < size) {
        n += written(
            snprintf(
                out + n, size - n, "\nLogin: %.*s", (int)proxy.user_len, proxy.line + proxy.user_at),
            size - n);
    } else if(proxy.login) {
        append(out, size, &n, "%s", "\nWith a login");
    }
    return n;
}

size_t hproxy_result_label(const HproxyResult* result, bool answered, char* out, size_t size) {
    if(!result || !out || size == 0) return 0;
    size_t n = 0;
    switch(hproxy_verdict(result, answered)) {
    case HproxyVerdictWorks:
        n = hproxy_result_tag(result, out, size);
        break;
    case HproxyVerdictSlow:
        n = written(snprintf(out, size, "slow"), size);
        break;
    case HproxyVerdictDead:
        n = written(snprintf(out, size, "dead"), size);
        break;
    case HproxyVerdictLocal:
        n = written(snprintf(out, size, "local"), size);
        break;
    case HproxyVerdictUnread:
        n = written(snprintf(out, size, "unread"), size);
        break;
    }
    if(n + 2 >= size) return n;
    out[n++] = ' ';
    out[n] = '\0';
    return n + result_address(result, out + n, size - n);
}

static const char* dead_reason(const HproxyResult* result) {
    static const struct {
        const char* failure;
        const char* reason;
    } reasons[] = {
        {"refused", "Dead: nothing answers at this address."},
        {"timeout", "Dead or slow: no answer within 1.5 seconds."},
        {"bad_status",
         "Something answers there but turns the check away. It may want a login, or a different "
         "one."},
        {"no_echo", "Something answers there, but it passes no traffic on: not a proxy."},
        {"tls_error", "Dead: a TLS error on the way through it."},
        {"transport_error", "Dead: the connection broke off."},
    };
    if(strcmp(result->status, "unresolved") == 0) {
        return "Dead: the name does not resolve. No DNS answer for this host.";
    }
    for(size_t i = 0; i < sizeof(reasons) / sizeof(reasons[0]); i++) {
        if(strcmp(result->failure, reasons[i].failure) == 0) return reasons[i].reason;
    }
    return "Dead: no proxy answered at this address.";
}

size_t hproxy_result_detail(const HproxyResult* result, bool answered, char* out, size_t size) {
    if(!result || !out || size == 0) return 0;
    size_t n = result_heading(result, out, size);
    append(out, size, &n, "%s", "\n\n");
    switch(hproxy_verdict(result, answered)) {
    case HproxyVerdictWorks:
        append(out, size, &n, "%s", "Works");
        if(result->latency_ms >= 0 && n + 1 < size) {
            n += written(
                snprintf(out + n, size - n, ", answered in %ld ms", (long)result->latency_ms),
                size - n);
        }
        append(out, size, &n, "%s", "\n");
        if(result->protocols[0]) append(out, size, &n, "Protocols: %s\n", result->protocols);
        if(result->country[0]) append(out, size, &n, "Country: %s\n", result->country);
        if(result->anonymity[0]) append(out, size, &n, "Anonymity: %s\n", result->anonymity);
        return n;
    case HproxyVerdictSlow:
        append(
            out,
            size,
            &n,
            "%s",
            "No answer in time: nothing came back within the 2 seconds the WiFi board waits. "
            "Slow, or dead.\n");
        return n;
    case HproxyVerdictLocal:
        append(
            out,
            size,
            &n,
            "%s",
            "Not checkable here: a private or reserved address. hproxy.com cannot reach your own "
            "network.\n");
        return n;
    case HproxyVerdictUnread:
        append(out, size, &n, "%s", "hproxy.com could not read this line.\n");
        return n;
    case HproxyVerdictDead:
        append(out, size, &n, "%s\n", dead_reason(result));
        if(result->country[0]) append(out, size, &n, "Country: %s\n", result->country);
        return n;
    }
    return n;
}

/* Characters a URL's username or password may hold without escaping. */
static bool url_safe(const char* s, size_t len) {
    for(size_t i = 0; i < len; i++) {
        char c = s[i];
        if(!(is_alpha(c) || is_digit(c) || c == '-' || c == '.' || c == '_' || c == '~')) {
            return false;
        }
    }
    return true;
}

size_t hproxy_alive_line(const HproxyResult* result, char* out, size_t size) {
    if(!result || !out || size == 0) return 0;
    HproxyProxy proxy;
    bool parsed = hproxy_proxy_parse(result->input, strlen(result->input), &proxy) ==
                  HproxyLineProxy;
    bool web = has_protocol(result->protocols, "http") || has_protocol(result->protocols, "https");
    bool socks5 = has_protocol(result->protocols, "socks5");
    bool socks4 = has_protocol(result->protocols, "socks4");
    /* A bare line means HTTP to curl and most tools: only a SOCKS-only proxy needs its word. */
    if(!parsed || proxy.scheme_len || web || !(socks5 || socks4)) {
        return written(snprintf(out, size, "%s", result->input), size);
    }
    const char* scheme = socks5 ? "socks5" : "socks4";
    char address[HPROXY_LINE_MAX + 2];
    hproxy_proxy_address(&proxy, address, sizeof(address));
    if(!proxy.login) return written(snprintf(out, size, "%s://%s", scheme, address), size);
    if(socks5 && proxy.pair && proxy.user_len > 0 &&
       url_safe(proxy.line + proxy.user_at, proxy.user_len) &&
       url_safe(proxy.line + proxy.pass_at, proxy.pass_len)) {
        return written(
            snprintf(
                out,
                size,
                "socks5://%.*s:%.*s@%s",
                (int)proxy.user_len,
                proxy.line + proxy.user_at,
                (int)proxy.pass_len,
                proxy.line + proxy.pass_at,
                address),
            size);
    }
    return written(snprintf(out, size, "%s", result->input), size);
}

/* ---- your connector ------------------------------------------------------------------------- */

bool hproxy_parse_connector(const char* line, HproxyConnector* c) {
    if(!line || !c) return false;
    memset(c, 0, sizeof(*c));
    c->member = -1;
    c->members = -1;
    const char* p = skip_space(line);
    if(*p != '{' || !json_bool(json_value(p, "ok"), &c->ok)) return false;
    json_string(json_value(p, "error"), c->error, sizeof(c->error));
    json_string(json_value(p, "upstream"), c->upstream, sizeof(c->upstream));
    json_string(json_value(p, "source"), c->source, sizeof(c->source));
    json_int(json_value(p, "member"), &c->member);
    json_int(json_value(p, "members"), &c->members);
    json_bool(json_value(p, "can_rotate"), &c->can_rotate);
    json_u64(json_value(p, "uptime_seconds"), &c->uptime_seconds);
    const char* stats = json_value(p, "stats");
    json_u64(json_value(stats, "connections"), &c->connections);
    json_u64(json_value(stats, "active"), &c->active);
    json_u64(json_value(stats, "bytes_up"), &c->bytes_up);
    json_u64(json_value(stats, "bytes_down"), &c->bytes_down);
    json_string(json_value(p, "version"), c->version, sizeof(c->version));
    return true;
}

static size_t bytes_text(uint64_t bytes, char* out, size_t size) {
    static const char* const units[] = {"KB", "MB", "GB", "TB"};
    if(bytes < 1024) return written(snprintf(out, size, "%u B", (unsigned)bytes), size);
    uint64_t tenths = bytes * 10 / 1024;
    size_t unit = 0;
    while(tenths >= 10240 && unit + 1 < sizeof(units) / sizeof(units[0])) {
        tenths /= 1024;
        unit++;
    }
    return written(
        snprintf(
            out,
            size,
            "%lu.%lu %s",
            (unsigned long)(tenths / 10),
            (unsigned long)(tenths % 10),
            units[unit]),
        size);
}

static size_t uptime_text(uint64_t s, char* out, size_t size) {
    if(s < 60) return written(snprintf(out, size, "%lu s", (unsigned long)s), size);
    if(s < 3600) return written(snprintf(out, size, "%lu min", (unsigned long)(s / 60)), size);
    if(s < 86400) {
        return written(
            snprintf(out, size, "%lu h %lu min", (unsigned long)(s / 3600), (unsigned long)(s % 3600 / 60)),
            size);
    }
    return written(
        snprintf(out, size, "%lu d %lu h", (unsigned long)(s / 86400), (unsigned long)(s % 86400 / 3600)),
        size);
}

/* The connector shows its proxy as "http://alice:********@gw.example.com:7777" or
 * "socks5://203.0.113.9:1080 (no login)". On a screen 30 characters wide the protocol goes next to
 * the proxy's number, and the stars, which say nothing, go. */
static void upstream_parts(const char* upstream, char* scheme, size_t scheme_size, char* rest, size_t rest_size) {
    scheme[0] = '\0';
    const char* body = upstream;
    const char* sep = strstr(upstream, "://");
    if(sep && (size_t)(sep - upstream) < scheme_size) {
        memcpy(scheme, upstream, (size_t)(sep - upstream));
        scheme[sep - upstream] = '\0';
        body = sep + 3;
    }
    size_t n = 0;
    for(const char* p = body; *p && n + 1 < rest_size;) {
        if(starts_with(p, ":********@")) {
            p += strlen(":********");
            continue;
        }
        if(strcmp(p, " (no login)") == 0) break;
        rest[n++] = *p++;
    }
    rest[n] = '\0';
}

size_t hproxy_connector_text(const HproxyConnector* c, bool switched, char* out, size_t size) {
    if(!c || !out || size == 0) return 0;
    size_t n = 0;
    out[0] = '\0';
    if(!c->ok) {
        append(out, size, &n, "The connector says:\n\n%s\n", c->error[0] ? c->error : "no.");
        return n;
    }
    if(switched) append(out, size, &n, "%s", "Switched.\n\n");
    char scheme[12];
    char rest[sizeof(c->upstream)];
    upstream_parts(c->upstream, scheme, sizeof(scheme), rest, sizeof(rest));
    const char* comma = scheme[0] ? ", " : "";
    if(strcmp(c->source, "list") == 0 && c->member > 0) {
        if(n + 1 < size) {
            n += written(
                snprintf(
                    out + n,
                    size - n,
                    "Proxy %ld of %ld%s%s\n",
                    (long)c->member,
                    (long)c->members,
                    comma,
                    scheme),
                size - n);
        }
    } else if(n + 1 < size) {
        n += written(
            snprintf(
                out + n,
                size - n,
                "%s%s%s\n",
                strcmp(c->source, "pool") == 0 ? "The free pool" : "One proxy",
                comma,
                scheme),
            size - n);
    }
    /* The address on its own line and the username under it, as on a proxy's own screen. */
    const char* at = strrchr(rest, '@');
    if(at && n + 1 < size) {
        n += written(
            snprintf(out + n, size - n, "%s\nLogin: %.*s\n", at + 1, (int)(at - rest), rest),
            size - n);
    } else if(rest[0]) {
        append(out, size, &n, "%s\n", rest);
    }
    char up[24];
    char down[24];
    bytes_text(c->bytes_up, up, sizeof(up));
    bytes_text(c->bytes_down, down, sizeof(down));
    if(n + 1 < size) {
        n += written(
            snprintf(
                out + n,
                size - n,
                "\nConnections: %lu, %lu open\nTraffic: %s up, %s down\n",
                (unsigned long)c->connections,
                (unsigned long)c->active,
                up,
                down),
            size - n);
    }
    char running[24];
    uptime_text(c->uptime_seconds, running, sizeof(running));
    append(out, size, &n, "Running for %s\n", running);
    if(!c->can_rotate) {
        append(out, size, &n, "%s", "New IP: not with one proxy.\n");
    }
    if(c->version[0]) append(out, size, &n, "hproxy %s\n", c->version);
    return n;
}

/* A host on your network: an IPv4 address, or names of letters, digits and '-' between dots. */
static bool lan_host_ok(const char* s, size_t len) {
    if(ipv4_ok(s, len)) return true;
    if(len == 0 || len > 253) return false;
    size_t label = 0;
    for(size_t i = 0; i < len; i++) {
        if(s[i] == '.') {
            if(label == 0) return false;
            label = 0;
        } else if(is_alpha(s[i]) || is_digit(s[i]) || s[i] == '-') {
            label++;
        } else {
            return false;
        }
    }
    return label > 0;
}

static bool digits_port(const char* s, size_t len, uint16_t* port) {
    if(len == 0 || len > 5) return false;
    for(size_t i = 0; i < len; i++) {
        if(!is_digit(s[i])) return false;
    }
    return parse_u16(s, len, port) && *port > 0;
}

bool hproxy_connector_address(const char* typed, char* out, size_t size) {
    if(!typed || !out || size == 0) return false;
    while(is_space(*typed))
        typed++;
    if(starts_with_nocase(typed, "https://")) return false; /* the connector's pages are plain HTTP */
    if(starts_with_nocase(typed, "http://")) typed += strlen("http://");
    size_t len = 0;
    while(typed[len] && typed[len] != '/' && !is_space(typed[len]))
        len++;
    if(len == 0) return false;
    /* After the address: a path (dropped), or spaces, and nothing more. */
    for(size_t i = len; typed[i] && typed[i] != '/'; i++) {
        if(!is_space(typed[i])) return false;
    }
    uint16_t port = 8080;
    const char* host = typed;
    size_t host_len = len;
    bool v6 = false;
    if(typed[0] == '[') {
        const char* close = memchr(typed, ']', len);
        if(!close) return false;
        host = typed + 1;
        host_len = (size_t)(close - host);
        size_t rest = (size_t)(close - typed) + 1;
        if(rest < len) {
            if(typed[rest] != ':' || !digits_port(typed + rest + 1, len - rest - 1, &port)) {
                return false;
            }
        }
        if(!ipv6_ok(host, host_len)) return false;
        v6 = true;
    } else if(ipv6_ok(typed, len)) {
        v6 = true; /* an IPv6 address without brackets or a port */
    } else {
        const char* colon = memchr(typed, ':', len);
        if(colon) {
            host_len = (size_t)(colon - typed);
            if(!digits_port(colon + 1, len - host_len - 1, &port)) return false;
        }
        if(!lan_host_ok(host, host_len)) return false;
    }
    int n = snprintf(
        out, size, v6 ? "[%.*s]:%u" : "%.*s:%u", (int)host_len, host, (unsigned)port);
    return n > 0 && (size_t)n < size;
}

bool hproxy_connector_url(const char* address, const char* page, char* out, size_t size) {
    if(!address || !address[0] || !page || !out || size == 0) return false;
    int n = snprintf(out, size, "http://%s/hproxy/%s", address, page);
    return n > 0 && (size_t)n < size;
}

static size_t base64(const unsigned char* in, size_t len, char* out, size_t size) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t need = (len + 2) / 3 * 4;
    if(need + 1 > size) return 0;
    size_t n = 0;
    for(size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if(i + 1 < len) v |= (uint32_t)in[i + 1] << 8;
        if(i + 2 < len) v |= in[i + 2];
        out[n++] = alphabet[(v >> 18) & 63];
        out[n++] = alphabet[(v >> 12) & 63];
        out[n++] = i + 1 < len ? alphabet[(v >> 6) & 63] : '=';
        out[n++] = i + 2 < len ? alphabet[v & 63] : '=';
    }
    out[n] = '\0';
    return n;
}

bool hproxy_login_headers(const char* login, char* out, size_t size) {
    if(!login || !out || size == 0) return false;
    size_t len = strlen(login);
    if(len == 0 || len >= HPROXY_LOGIN_MAX || !strchr(login, ':')) return false;
    for(size_t i = 0; i < len; i++) {
        if((unsigned char)login[i] < 0x20 || (unsigned char)login[i] >= 0x7f) return false;
    }
    char encoded[((HPROXY_LOGIN_MAX + 2) / 3) * 4 + 1];
    if(!base64((const unsigned char*)login, len, encoded, sizeof(encoded))) return false;
    int n = snprintf(out, size, "{\"Authorization\":\"Basic %s\"}", encoded);
    return n > 0 && (size_t)n < size;
}

bool hproxy_link_ok(const char* link) {
    if(!link) return false;
    size_t scheme;
    if(starts_with_nocase(link, "https://")) {
        scheme = strlen("https://");
    } else if(starts_with_nocase(link, "http://")) {
        scheme = strlen("http://");
    } else {
        return false;
    }
    size_t len = strlen(link);
    if(len <= scheme || len >= HPROXY_LINK_MAX) return false;
    if(link[scheme] == '/' || link[scheme] == '?' || link[scheme] == '#') return false; /* no host */
    for(size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)link[i];
        /* The board takes the link inside a JSON string and a command line. */
        if(c <= 0x20 || c >= 0x7f || c == '"' || c == '\\') return false;
    }
    return true;
}

/* ---- settings ------------------------------------------------------------------------------- */

bool hproxy_setting(const char* text, const char* key, char* out, size_t size) {
    if(!text || !key || !out || size == 0) return false;
    size_t key_len = strlen(key);
    const char* p = text;
    while(*p) {
        const char* end = strchr(p, '\n');
        size_t len = end ? (size_t)(end - p) : strlen(p);
        if(len > key_len && memcmp(p, key, key_len) == 0 && p[key_len] == '=') {
            size_t value = len - key_len - 1;
            while(value > 0 && is_space(p[key_len + value])) /* a CR from a file edited on Windows */
                value--;
            if(value >= size) value = size - 1;
            memcpy(out, p + key_len + 1, value);
            out[value] = '\0';
            return true;
        }
        p += len;
        if(*p == '\n') p++;
    }
    return false;
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
