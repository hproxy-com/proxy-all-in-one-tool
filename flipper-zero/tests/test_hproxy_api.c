/* Tests for hproxy_api.c, built and run on any computer:
 *
 *   cc -std=c11 -Wall -Wextra -Werror -I. tests/test_hproxy_api.c hproxy_api.c -o test_hproxy_api
 *   ./test_hproxy_api
 *
 * The proxy lines are the shapes hproxy.com's checker reads (its proxy_line_parser.rs tests), and
 * the check rows and connector answers have the shape of real ones, with every address replaced by
 * one from the ranges kept for documentation (RFC 5737, RFC 3849). */
#include "hproxy_api.h"

#include <stdio.h>
#include <string.h>

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        checks++;                                                         \
        if(!(cond)) {                                                     \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);        \
            failures++;                                                   \
        }                                                                 \
    } while(0)

#define CHECK_STR(got, want)                                                                  \
    do {                                                                                      \
        checks++;                                                                             \
        if(strcmp((got), (want)) != 0) {                                                      \
            printf("FAIL %s:%d:\n  got  \"%s\"\n  want \"%s\"\n", __FILE__, __LINE__, (got), \
                   (want));                                                                   \
            failures++;                                                                       \
        }                                                                                     \
    } while(0)

/* ---- proxy lines ---------------------------------------------------------------------------- */

static HproxyProxy p;

static HproxyLineKind parse(const char* line) {
    return hproxy_proxy_parse(line, strlen(line), &p);
}

static const char* part(uint8_t at, uint8_t len) {
    static char text[HPROXY_LINE_MAX];
    snprintf(text, sizeof(text), "%.*s", (int)len, p.line + at);
    return text;
}

#define HOST() part(p.host_at, p.host_len)
#define USER() part(p.user_at, p.user_len)
#define PASS() part(p.pass_at, p.pass_len)

/* host, port, and the login when there is one ("" for none). */
static void expect(const char* line, const char* host, unsigned port, const char* user, const char* pass) {
    checks++;
    if(parse(line) != HproxyLineProxy) {
        printf("FAIL: \"%s\" was not read as a proxy\n", line);
        failures++;
        return;
    }
    CHECK_STR(HOST(), host);
    CHECK(p.port == port);
    if(user) {
        CHECK(p.login && p.pair);
        CHECK_STR(USER(), user);
        CHECK_STR(PASS(), pass);
    } else {
        CHECK(!p.login && !p.pair);
    }
}

static void proxy_lines(void) {
    /* The shapes providers print. */
    expect("192.0.2.4:8080", "192.0.2.4", 8080, NULL, NULL);
    expect("  192.0.2.11:80\r\n", "192.0.2.11", 80, NULL, NULL);
    CHECK_STR(p.line, "192.0.2.11:80");
    expect("socks5://198.51.100.8:1080", "198.51.100.8", 1080, NULL, NULL);
    CHECK(p.scheme_len == 6);
    expect("proxy.example.com:3128", "proxy.example.com", 3128, NULL, NULL);
    expect("[2001:db8::1]:8080", "2001:db8::1", 8080, NULL, NULL);
    expect("[::1]:3128", "::1", 3128, NULL, NULL);
    expect("[::ffff:192.0.2.1]:8080", "::ffff:192.0.2.1", 8080, NULL, NULL);
    expect("2001:db8:3020:3781::b2:8080", "2001:db8:3020:3781::b2", 8080, NULL, NULL);
    expect("192.0.2.4:8080/some/path", "192.0.2.4", 8080, NULL, NULL);
    expect("192.0.2.4::8080", "192.0.2.4", 8080, NULL, NULL);
    expect("192.0.2.4  8080", "192.0.2.4", 8080, NULL, NULL);
    expect("[2001:db8::1]8080", "2001:db8::1", 8080, NULL, NULL); /* the checker takes it */
    expect("192.0.2.4:+80", "192.0.2.4", 80, NULL, NULL); /* so does Rust's u16 */

    /* With a login, in every place a provider puts it. */
    expect("user:pass@192.0.2.4:80", "192.0.2.4", 80, "user", "pass");
    expect("192.0.2.4:80:user:pass", "192.0.2.4", 80, "user", "pass");
    expect("http://u:p@host.example:80", "host.example", 80, "u", "p");
    CHECK(p.scheme_len == 4);
    expect("[2001:db8::1]:8080:u:p", "2001:db8::1", 8080, "u", "p");
    expect("u:p@[2001:db8::1]:8080", "2001:db8::1", 8080, "u", "p");
    expect("2001:db8:3020:3781::b2:8080:u:p", "2001:db8:3020:3781::b2", 8080, "u", "p");
    expect("192.0.2.4:8080@myuser:mypass", "192.0.2.4", 8080, "myuser", "mypass");
    expect("192.0.2.4,8080,myuser,mypass", "192.0.2.4", 8080, "myuser", "mypass");
    expect("192.0.2.4|8080|myuser|mypass", "192.0.2.4", 8080, "myuser", "mypass");
    expect("192.0.2.4\t8080\tmyuser\tmypass", "192.0.2.4", 8080, "myuser", "mypass");
    CHECK_STR(p.line, "192.0.2.4 8080 myuser mypass"); /* tabs travel as spaces */
    expect("192.0.2.4 8080 myuser mypass", "192.0.2.4", 8080, "myuser", "mypass");
    expect("myuser:mypass:192.0.2.4:8080", "192.0.2.4", 8080, "myuser", "mypass");
    expect("gate.example.com:7000:user1:pass1", "gate.example.com", 7000, "user1", "pass1");
    expect(
        "qxlatp2o3x-country-us:fto1oxdhxp@gate.example.com:30",
        "gate.example.com",
        30,
        "qxlatp2o3x-country-us",
        "fto1oxdhxp");
    expect("user:p@ss@192.0.2.4:8080", "192.0.2.4", 8080, "user", "p@ss");
    expect("user:a:b@192.0.2.4:8080", "192.0.2.4", 8080, "user", "a:b");
    expect("http://user:pass@gate.example.com:3128/whatever", "gate.example.com", 3128, "user", "pass");
    expect("socks5h://user:pass@gate.example.com:1080", "gate.example.com", 1080, "user", "pass");
    CHECK(p.scheme_len == 7);
    expect("user@192.0.2.4:80", "192.0.2.4", 80, "user", "");

    /* More than one username and one password: the checker sends no login, and the app still
     * counts the line as one with a login, so it never leaves the Flipper unasked. */
    CHECK(parse("192.0.2.4:8080:a:b:c") == HproxyLineProxy);
    CHECK(p.login && !p.pair);
    CHECK(parse("192.0.2.4:80 fast") == HproxyLineProxy);
    CHECK(p.login && !p.pair);
    CHECK(parse("gate.example.com:8080:user:9f:a2:c1") == HproxyLineProxy);
    CHECK(p.login && !p.pair);

    CHECK(parse("") == HproxyLineBlank);
    CHECK(parse("   \r\n") == HproxyLineBlank);
    CHECK(parse("# my proxies") == HproxyLineBlank);

    CHECK(parse("192.0.2.4") == HproxyLineInvalid);
    CHECK(parse("192.0.2.4:") == HproxyLineInvalid);
    CHECK(parse("192.0.2.4:0") == HproxyLineInvalid);
    CHECK(parse("192.0.2.4:65536") == HproxyLineInvalid);
    CHECK(parse("192.0.2.999:80") == HproxyLineInvalid); /* an address with a typo, never a name */
    CHECK(parse("192.0.02.4:80") == HproxyLineInvalid); /* no leading zeros, as in Rust */
    CHECK(parse("not_an_ip:80") == HproxyLineInvalid);
    CHECK(parse("localhost:80") == HproxyLineInvalid);
    CHECK(parse("-bad.example.com:80") == HproxyLineInvalid);
    CHECK(parse("a\"b.example:80") == HproxyLineInvalid);
    CHECK(parse(":8080") == HproxyLineInvalid);
    CHECK(parse("user:pass@nowhere") == HproxyLineInvalid);
    CHECK(parse("[2001:db8::1:2:3:4:5:6]:80") == HproxyLineInvalid); /* nine groups */
    CHECK(parse("192.0.2.4:80\xc3\xa9") == HproxyLineInvalid); /* the Flipper cannot show it */
    CHECK(parse("socks5://") == HproxyLineInvalid);
    CHECK(
        parse("a-very-long-host-name-that-goes-on-and-on-and-on-and-on.example.com.another.part."
              "and-more-and-more-and-more-and-more.example:8080") == HproxyLineTooLong);

    /* Labels: the address, the protocol a line names, a username; never a password. */
    char label[HPROXY_LINE_MAX + 16];
    parse("192.0.2.4:8080");
    hproxy_proxy_label(&p, label, sizeof(label));
    CHECK_STR(label, "192.0.2.4:8080");
    parse("SOCKS5://198.51.100.8:1080");
    hproxy_proxy_label(&p, label, sizeof(label));
    CHECK_STR(label, "socks5 198.51.100.8:1080");
    parse("gate.example.com:7000:alice:s3cret");
    hproxy_proxy_label(&p, label, sizeof(label));
    CHECK_STR(label, "alice@gate.example.com:7000");
    parse("[2001:db8::1]:8080:u:p");
    hproxy_proxy_label(&p, label, sizeof(label));
    CHECK_STR(label, "u@[2001:db8::1]:8080");
    parse("192.0.2.4:8080:a:b:c");
    hproxy_proxy_label(&p, label, sizeof(label));
    CHECK_STR(label, "192.0.2.4:8080 (login)");
    parse(":s3cret@192.0.2.4:80");
    hproxy_proxy_label(&p, label, sizeof(label));
    CHECK_STR(label, "192.0.2.4:80 (login)");
    char tiny[8];
    parse("gate.example.com:7000:alice:s3cret");
    hproxy_proxy_label(&p, tiny, sizeof(tiny));
    CHECK(strlen(tiny) == 7);

    /* The same proxy written two ways is one proxy. */
    HproxyProxy a;
    HproxyProxy b;
    hproxy_proxy_parse("192.0.2.4:80:u:p", 16, &a);
    hproxy_proxy_parse("u:p@192.0.2.4:80", 16, &b);
    CHECK(hproxy_proxy_same(&a, &b));
    hproxy_proxy_parse("socks5://192.0.2.4:80", 21, &a);
    hproxy_proxy_parse("192.0.2.4:80", 12, &b);
    CHECK(hproxy_proxy_same(&a, &b));
    hproxy_proxy_parse("GATE.example.com:80", 19, &a);
    hproxy_proxy_parse("gate.example.com:80", 19, &b);
    CHECK(hproxy_proxy_same(&a, &b));
    hproxy_proxy_parse("192.0.2.4:80:u:p", 16, &a);
    hproxy_proxy_parse("192.0.2.4:80:u:q", 16, &b);
    CHECK(!hproxy_proxy_same(&a, &b));
    hproxy_proxy_parse("192.0.2.4:80", 12, &a);
    hproxy_proxy_parse("192.0.2.4:81", 12, &b);
    CHECK(!hproxy_proxy_same(&a, &b));
    hproxy_proxy_parse("192.0.2.4:80:u:p", 16, &b);
    CHECK(!hproxy_proxy_same(&a, &b));
}

/* ---- check requests ------------------------------------------------------------------------- */

/* The whole command the board formats must fit its 512-byte buffer. */
static size_t command_length(const char* payload) {
    char command[1024];
    int n = snprintf(
        command,
        sizeof(command),
        "[POST/HTTP]{\"url\":\"%s\",\"headers\":%s,\"payload\":%s}",
        HPROXY_CHECK_URL,
        HPROXY_POST_HEADERS,
        payload);
    return n < 0 ? 0 : (size_t)n;
}

static void check_payloads(void) {
    char body[512];
    const char* three[] = {"192.0.2.4:80", "198.51.100.8:3128:alice:s3cret", "[2001:db8::1]:8080"};
    CHECK(hproxy_check_payload(body, sizeof(body), three, 3) == 3);
    CHECK_STR(
        body,
        "{\"proxies\":[\"192.0.2.4:80\",\"198.51.100.8:3128:alice:s3cret\",\"[2001:db8::1]:8080\"],"
        "\"timeout_ms\":1500,\"retries\":0}");
    CHECK(command_length(body) <= HPROXY_BOARD_COMMAND_MAX - 1);

    /* A password with a quote and a backslash stays valid JSON. */
    const char* odd[] = {"user:pa\"ss\\@192.0.2.4:80"};
    CHECK(hproxy_check_payload(body, sizeof(body), odd, 1) == 1);
    CHECK_STR(
        body, "{\"proxies\":[\"user:pa\\\"ss\\\\@192.0.2.4:80\"],\"timeout_ms\":1500,\"retries\":0}");

    /* Thirty typical addresses: one batch takes at most HPROXY_BATCH_MAX, and fits. */
    const char* many[30];
    for(int i = 0; i < 30; i++)
        many[i] = "203.0.113.146:8888";
    CHECK(hproxy_check_payload(body, sizeof(body), many, 30) == HPROXY_BATCH_MAX);
    CHECK(command_length(body) <= HPROXY_BOARD_COMMAND_MAX - 1);

    /* Long lines with a login: fewer per batch, still inside the buffer. */
    const char* longer[10];
    for(int i = 0; i < 10; i++)
        longer[i] = "gate.provider-example.com:7777:customer-acme-zone-resi-country-us-session-a1b2c3:"
                    "Xy9-very-long-password-0123456789";
    size_t packed = hproxy_check_payload(body, sizeof(body), longer, 10);
    CHECK(packed >= 2 && packed < 10);
    CHECK(command_length(body) <= HPROXY_BOARD_COMMAND_MAX - 1);

    /* The longest line the app keeps, every character escaped, still goes on its own. */
    char worst[HPROXY_LINE_MAX];
    memset(worst, '"', sizeof(worst) - 1);
    worst[sizeof(worst) - 1] = '\0';
    const char* alone[] = {worst};
    CHECK(hproxy_check_payload(body, sizeof(body), alone, 1) == 1);
    CHECK(command_length(body) <= HPROXY_BOARD_COMMAND_MAX - 1);

    CHECK(hproxy_check_payload(body, sizeof(body), three, 0) == 0);
    CHECK(hproxy_check_payload_budget() > 300);
}

/* ---- the checker's rows --------------------------------------------------------------------- */

static void check_rows(void) {
    HproxyResult r;
    char shown[320];
    const char* alive =
        "{\"input\":\"192.0.2.10:80\",\"status\":\"alive\",\"ip\":\"192.0.2.10\",\"port\":80,"
        "\"exit_ip\":\"192.0.2.10\",\"alive\":true,\"protocols\":[\"http\",\"https\"],\"supports_udp\":null,"
        "\"speed_mbps\":null,\"anonymity\":\"anonymous\",\"latency_ms\":55,\"country_code\":\"US\","
        "\"region\":\"Example\",\"city\":null,\"asn\":64500,\"asn_org\":\"Example Hosting\","
        "\"is_datacenter\":true,\"error\":null,\"failure\":null}";
    CHECK(hproxy_parse_check_row(alive, &r) == HproxyRowResult);
    CHECK_STR(r.input, "192.0.2.10:80");
    CHECK(r.alive);
    CHECK(r.latency_ms == 55);
    CHECK_STR(r.country, "US");
    CHECK_STR(r.anonymity, "anonymous");
    CHECK_STR(r.status, "alive");
    CHECK_STR(r.failure, "");
    CHECK_STR(r.protocols, "http, https");
    CHECK(hproxy_verdict(&r, true) == HproxyVerdictWorks);
    hproxy_result_label(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "https 192.0.2.10:80");
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(
        shown,
        "192.0.2.10:80\n\nWorks, answered in 55 ms\nProtocols: http, https\nCountry: US\n"
        "Anonymity: anonymous\n");
    hproxy_alive_line(&r, shown, sizeof(shown));
    CHECK_STR(shown, "192.0.2.10:80");

    /* A refused address, whose error text holds quotes and the word "input". */
    const char* forbidden =
        "{\"input\":\"198.51.100.7:8080\",\"status\":\"forbidden\",\"ip\":null,\"port\":null,"
        "\"exit_ip\":null,\"alive\":false,\"protocols\":[],\"supports_udp\":null,\"speed_mbps\":null,"
        "\"anonymity\":null,\"latency_ms\":null,\"country_code\":null,\"region\":null,\"city\":null,"
        "\"asn\":null,\"asn_org\":null,\"is_datacenter\":null,\"error\":\"target not allowed: "
        "\\\"input\\\":\\\"x\\\" loopback, private\",\"failure\":null}";
    CHECK(hproxy_parse_check_row(forbidden, &r) == HproxyRowResult);
    CHECK_STR(r.input, "198.51.100.7:8080");
    CHECK(!r.alive);
    CHECK(r.latency_ms == -1);
    CHECK_STR(r.country, "");
    CHECK_STR(r.protocols, "");
    CHECK(hproxy_verdict(&r, true) == HproxyVerdictLocal);
    hproxy_result_label(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "local 198.51.100.7:8080");
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(
        shown,
        "198.51.100.7:8080\n\nNot checkable here: a private or reserved address. hproxy.com cannot "
        "reach your own network.\n");

    /* Dead, with the reason the checker gives. */
    const char* refused =
        "{\"input\":\"203.0.113.82:3118\",\"status\":\"dead\",\"alive\":false,\"protocols\":[],"
        "\"latency_ms\":null,\"country_code\":\"CA\",\"failure\":\"refused\"}";
    CHECK(hproxy_parse_check_row(refused, &r) == HproxyRowResult);
    CHECK_STR(r.failure, "refused");
    CHECK(hproxy_verdict(&r, true) == HproxyVerdictDead);
    hproxy_result_label(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "dead 203.0.113.82:3118");
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "203.0.113.82:3118\n\nDead: nothing answers at this address.\nCountry: CA\n");

    const char* wrong_login =
        "{\"input\":\"gate.example.com:7000:alice:s3cret\",\"status\":\"dead\",\"alive\":false,"
        "\"protocols\":[],\"failure\":\"bad_status\"}";
    CHECK(hproxy_parse_check_row(wrong_login, &r) == HproxyRowResult);
    hproxy_result_label(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "dead alice@gate.example.com:7000");
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(
        shown,
        "gate.example.com:7000\nLogin: alice\n\nSomething answers there but turns the check away. "
        "It may want a login, or a different one.\n");
    CHECK(strstr(shown, "s3cret") == NULL);

    /* The detail screen's picture in tools/screens.py says exactly this. */
    const char* gateway =
        "{\"input\":\"gate.example.com:7000:alice:s3cret\",\"status\":\"alive\",\"alive\":true,"
        "\"protocols\":[\"http\",\"https\"],\"latency_ms\":182,\"country_code\":\"US\","
        "\"anonymity\":\"elite\"}";
    CHECK(hproxy_parse_check_row(gateway, &r) == HproxyRowResult);
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(
        shown,
        "gate.example.com:7000\nLogin: alice\n\nWorks, answered in 182 ms\nProtocols: http, https\n"
        "Country: US\nAnonymity: elite\n");

    /* A login that is not one username and one password: said, never shown. */
    const char* odd_login =
        "{\"input\":\"192.0.2.4:8080:a:b:c\",\"status\":\"alive\",\"alive\":true,\"protocols\":[\"http\"]}";
    CHECK(hproxy_parse_check_row(odd_login, &r) == HproxyRowResult);
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "192.0.2.4:8080\nWith a login\n\nWorks\nProtocols: http\n");
    hproxy_result_label(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "http 192.0.2.4:8080 (login)");

    const char* unresolved =
        "{\"input\":\"gate.example.com:7000\",\"status\":\"unresolved\",\"alive\":false,"
        "\"protocols\":[]}";
    CHECK(hproxy_parse_check_row(unresolved, &r) == HproxyRowResult);
    CHECK(hproxy_verdict(&r, true) == HproxyVerdictDead);
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(
        shown,
        "gate.example.com:7000\n\nDead: the name does not resolve. No DNS answer for this host.\n");

    /* No answer inside the board's window. */
    memset(&r, 0, sizeof(r));
    snprintf(r.input, sizeof(r.input), "203.0.113.91:3128");
    CHECK(hproxy_verdict(&r, false) == HproxyVerdictSlow);
    hproxy_result_label(&r, false, shown, sizeof(shown));
    CHECK_STR(shown, "slow 203.0.113.91:3128");

    /* Keys in any order, nested values before them, spaces around; the array keeps its strings. */
    const char* shuffled =
        " { \"protocols\" : [\"http\",{\"x\":[1,2]},\"socks5\"] , \"alive\" : true , \"input\" : "
        "\"192.0.2.1:80\" } ";
    CHECK(hproxy_parse_check_row(shuffled, &r) == HproxyRowResult);
    CHECK_STR(r.input, "192.0.2.1:80");
    CHECK(r.alive);
    CHECK_STR(r.protocols, "http, socks5");
    hproxy_result_tag(&r, shown, sizeof(shown));
    CHECK_STR(shown, "http+socks5");
    hproxy_result_detail(&r, true, shown, sizeof(shown));
    CHECK_STR(shown, "192.0.2.1:80\n\nWorks\nProtocols: http, socks5\n");

    /* All four fit, whole; a name that does not fit ends the list, never half of it. */
    const char* many =
        "{\"input\":\"192.0.2.2:1080\",\"alive\":true,\"protocols\":[\"http\",\"https\",\"socks4\","
        "\"socks5\",\"socks5h\",\"udp\"]}";
    CHECK(hproxy_parse_check_row(many, &r) == HproxyRowResult);
    CHECK_STR(r.protocols, "http, https, socks4, socks5, socks5h");
    hproxy_result_tag(&r, shown, sizeof(shown));
    CHECK_STR(shown, "https+socks5");

    /* A tiny buffer still ends with a terminating zero. */
    char tiny[6];
    hproxy_result_detail(&r, true, tiny, sizeof(tiny));
    CHECK(strlen(tiny) == 5);
    hproxy_result_label(&r, true, tiny, sizeof(tiny));
    CHECK(strlen(tiny) == 5);

    /* A quote in the line comes back as it went. */
    const char* quoted = "{\"input\":\"user:pa\\\"ss\\\\@192.0.2.4:80\",\"alive\":false}";
    CHECK(hproxy_parse_check_row(quoted, &r) == HproxyRowResult);
    CHECK_STR(r.input, "user:pa\"ss\\@192.0.2.4:80");

    CHECK(hproxy_parse_check_row("{\"_event\":\"end\",\"done\":1,\"duration_ms\":0,\"total\":1}", &r) == HproxyRowEnd);
    CHECK(hproxy_parse_check_row("{\"_event\":\"progress\",\"done\":3}", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("not json", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("{}", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("{\"input\":", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("{\"alive\":true}", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("[\"input\",\"x\"]", &r) == HproxyRowOther);
}

/* ---- alive.txt -------------------------------------------------------------------------------- */

static const char* alive_line(const char* input, const char* protocols) {
    static char out[HPROXY_LINE_MAX + 16];
    HproxyResult r;
    memset(&r, 0, sizeof(r));
    r.alive = true;
    snprintf(r.input, sizeof(r.input), "%s", input);
    snprintf(r.protocols, sizeof(r.protocols), "%s", protocols);
    hproxy_alive_line(&r, out, sizeof(out));
    return out;
}

static void alive_lines(void) {
    /* A bare line means HTTP everywhere, so an HTTP proxy stays as it was written. */
    CHECK_STR(alive_line("203.0.113.24:8080", "http, https"), "203.0.113.24:8080");
    CHECK_STR(alive_line("203.0.113.24:8080:alice:s3cret", "https"), "203.0.113.24:8080:alice:s3cret");
    /* A SOCKS proxy gets its word, so other tools speak the right protocol. */
    CHECK_STR(alive_line("203.0.113.24:1080", "socks5"), "socks5://203.0.113.24:1080");
    CHECK_STR(alive_line("203.0.113.24:1080", "socks4"), "socks4://203.0.113.24:1080");
    CHECK_STR(alive_line("[2001:db8::1]:1080", "socks4, socks5"), "socks5://[2001:db8::1]:1080");
    CHECK_STR(alive_line("203.0.113.24:1080:alice:s3cret", "socks5"), "socks5://alice:s3cret@203.0.113.24:1080");
    /* A password a URL cannot hold as it is, a SOCKS4 login, a line that names its protocol: as written. */
    CHECK_STR(alive_line("203.0.113.24:1080:alice:p@ss", "socks5"), "203.0.113.24:1080:alice:p@ss");
    CHECK_STR(alive_line("203.0.113.24:1080:alice:x", "socks4"), "203.0.113.24:1080:alice:x");
    CHECK_STR(alive_line("socks4://203.0.113.24:1080", "socks4"), "socks4://203.0.113.24:1080");
    CHECK_STR(alive_line("http://203.0.113.24:1080", "socks5"), "http://203.0.113.24:1080");
}

/* ---- the connector ---------------------------------------------------------------------------- */

static void connector(void) {
    HproxyConnector c;
    char text[400];
    const char* status =
        "{\"ok\":true,\"upstream\":\"http://alice:********@gw.example.com:7777\",\"source\":\"list\","
        "\"member\":4,\"members\":10,\"can_rotate\":true,\"uptime_seconds\":11520,\"stats\":"
        "{\"connections\":1234,\"active\":3,\"failures\":2,\"rotations\":7,\"bytes_up\":12902400,"
        "\"bytes_down\":478150656},\"version\":\"0.4.9\"}";
    CHECK(hproxy_parse_connector(status, &c));
    CHECK(c.ok);
    CHECK(c.member == 4 && c.members == 10);
    CHECK(c.connections == 1234 && c.active == 3);
    CHECK(c.bytes_down == 478150656ULL);
    hproxy_connector_text(&c, false, text, sizeof(text));
    CHECK_STR(
        text,
        "Proxy 4 of 10, http\ngw.example.com:7777\nLogin: alice\n\nConnections: 1234, 3 open\n"
        "Traffic: 12.3 MB up, 456.0 MB down\nRunning for 3 h 12 min\nhproxy 0.4.9\n");
    hproxy_connector_text(&c, true, text, sizeof(text));
    CHECK(strncmp(text, "Switched.\n\nProxy 4 of 10, http\n", 31) == 0);

    const char* fixed =
        "{\"ok\":true,\"upstream\":\"socks5://203.0.113.9:1080 (no login)\",\"source\":\"fixed\","
        "\"member\":null,\"members\":null,\"can_rotate\":false,\"uptime_seconds\":42,\"stats\":"
        "{\"connections\":0,\"active\":0,\"bytes_up\":0,\"bytes_down\":512},\"version\":\"0.4.9\"}";
    CHECK(hproxy_parse_connector(fixed, &c));
    CHECK(c.member == -1);
    hproxy_connector_text(&c, false, text, sizeof(text));
    CHECK_STR(
        text,
        "One proxy, socks5\n203.0.113.9:1080\n\nConnections: 0, 0 open\n"
        "Traffic: 0 B up, 512 B down\nRunning for 42 s\nNew IP: not with one proxy.\nhproxy 0.4.9\n");

    const char* refused =
        "{\"ok\":false,\"error\":\"member picks a proxy of a list, and this relay goes through no list\"}";
    CHECK(hproxy_parse_connector(refused, &c));
    CHECK(!c.ok);
    hproxy_connector_text(&c, true, text, sizeof(text));
    CHECK_STR(
        text, "The connector says:\n\nmember picks a proxy of a list, and this relay goes through no list\n");

    CHECK(!hproxy_parse_connector("[GET/END]", &c));
    CHECK(!hproxy_parse_connector("{\"upstream\":\"x\"}", &c));

    /* Addresses as people type them. */
    char address[HPROXY_ADDRESS_MAX];
    CHECK(hproxy_connector_address("192.168.1.20:8080", address, sizeof(address)));
    CHECK_STR(address, "192.168.1.20:8080");
    CHECK(hproxy_connector_address("192.168.1.20", address, sizeof(address)));
    CHECK_STR(address, "192.168.1.20:8080");
    CHECK(hproxy_connector_address("http://nas.local:8081/hproxy", address, sizeof(address)));
    CHECK_STR(address, "nas.local:8081");
    CHECK(hproxy_connector_address(" raspberrypi ", address, sizeof(address)));
    CHECK_STR(address, "raspberrypi:8080");
    CHECK(hproxy_connector_address("[fe80::1]:9090", address, sizeof(address)));
    CHECK_STR(address, "[fe80::1]:9090");
    CHECK(hproxy_connector_address("fe80::1", address, sizeof(address)));
    CHECK_STR(address, "[fe80::1]:8080");
    CHECK(!hproxy_connector_address("https://192.168.1.20:8080", address, sizeof(address)));
    CHECK(!hproxy_connector_address("192.168.1.20:0", address, sizeof(address)));
    CHECK(!hproxy_connector_address("192.168.1.20:abc", address, sizeof(address)));
    CHECK(!hproxy_connector_address("bad host:80", address, sizeof(address)));
    CHECK(!hproxy_connector_address("", address, sizeof(address)));

    char url[HPROXY_LINK_MAX];
    CHECK(hproxy_connector_url("192.168.1.20:8080", "new-ip?member=3", url, sizeof(url)));
    CHECK_STR(url, "http://192.168.1.20:8080/hproxy/new-ip?member=3");
    CHECK(!hproxy_connector_url("", "status", url, sizeof(url)));

    char headers[200];
    CHECK(hproxy_login_headers("Aladdin:open sesame", headers, sizeof(headers)));
    CHECK_STR(headers, "{\"Authorization\":\"Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\"}");
    CHECK(!hproxy_login_headers("no-colon", headers, sizeof(headers)));
    CHECK(!hproxy_login_headers("", headers, sizeof(headers)));
}

/* ---- links and settings ------------------------------------------------------------------------- */

static void links_and_settings(void) {
    CHECK(hproxy_link_ok("https://proxy.example.com/list.txt"));
    CHECK(hproxy_link_ok("http://203.0.113.5/download/abc123/?format=txt&country=us"));
    CHECK(!hproxy_link_ok("ftp://proxy.example.com/list.txt"));
    CHECK(!hproxy_link_ok("https://"));
    CHECK(!hproxy_link_ok("https:///list.txt"));
    CHECK(!hproxy_link_ok("https://a b.example/"));
    CHECK(!hproxy_link_ok("https://a\"b.example/"));
    CHECK(!hproxy_link_ok("https://a\\b.example/"));
    CHECK(!hproxy_link_ok("proxy.example.com/list.txt"));

    const char* text = "send_logins=1\r\nlink=https://x.example/?a=b=c\r\nconnector=192.168.1.20:8080\n"
                       "linkx=no";
    char value[HPROXY_LINK_MAX];
    CHECK(hproxy_setting(text, "send_logins", value, sizeof(value)));
    CHECK_STR(value, "1");
    CHECK(hproxy_setting(text, "link", value, sizeof(value)));
    CHECK_STR(value, "https://x.example/?a=b=c");
    CHECK(hproxy_setting(text, "connector", value, sizeof(value)));
    CHECK_STR(value, "192.168.1.20:8080");
    CHECK(!hproxy_setting(text, "vibrate", value, sizeof(value)));
    CHECK(!hproxy_setting(text, "lin", value, sizeof(value)));
}

/* ---- the board's own lines ------------------------------------------------------------------ */

static void board_lines(void) {
    CHECK(hproxy_board_line("[GET/SUCCESS]{\"Status-Code\":200,\"Content-Length\":53}"));
    CHECK(hproxy_board_line("[POST/END]"));
    CHECK(hproxy_board_line("[ERROR] WiFi not connected."));
    CHECK(hproxy_board_line("[PONG]"));
    CHECK(!hproxy_board_line("[2001:db8::1]:8080"));
    CHECK(!hproxy_board_line("192.0.2.10:80"));
    CHECK(!hproxy_board_line("true"));
    CHECK(!hproxy_board_line("[]"));

    CHECK(hproxy_board_end("[GET/END]"));
    CHECK(hproxy_board_end("[POST/END]"));
    CHECK(!hproxy_board_end("[POST/SUCCESS]{\"Status-Code\":200}"));
    CHECK(hproxy_board_error("[ERROR] Failed to connect"));
    CHECK(!hproxy_board_error("ERROR"));

    CHECK(hproxy_board_status("[GET/SUCCESS]{\"Status-Code\":200,\"Content-Length\":53}") == 200);
    CHECK(hproxy_board_status("[POST/SUCCESS]{\"Status-Code\":429,\"Content-Length\":80}") == 429);
    CHECK(hproxy_board_status("[POST/SUCCESS] POST request successful.") == -1);
    CHECK(hproxy_board_status("[GET/END]") == -1);
    CHECK(hproxy_board_status("192.0.2.10:80") == -1);
}

int main(void) {
    proxy_lines();
    check_payloads();
    check_rows();
    alive_lines();
    connector();
    links_and_settings();
    board_lines();
    if(failures) {
        printf("%d of %d checks failed\n", failures, checks);
        return 1;
    }
    printf("all %d checks passed\n", checks);
    return 0;
}
