/* Tests for hproxy_api.c, built and run on any computer:
 *
 *   cc -std=c11 -Wall -Wextra -Werror -I. tests/test_hproxy_api.c hproxy_api.c -o test_hproxy_api
 *   ./test_hproxy_api
 *
 * The check rows are lines hproxy.com's checker really sent on 2026-11-18. */
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

static void the_list_url(void) {
    char url[192];
    CHECK(hproxy_list_url(url, sizeof(url), "socks5", "DE", 10));
    CHECK_STR(url, "https://hproxy.com/api/proxy-list?format=txt&limit=10&protocol=socks5&country=de");
    CHECK(hproxy_list_url(url, sizeof(url), NULL, NULL, 5));
    CHECK_STR(url, "https://hproxy.com/api/proxy-list?format=txt&limit=5");
    CHECK(hproxy_list_url(url, sizeof(url), "http", NULL, 50));
    CHECK_STR(url, "https://hproxy.com/api/proxy-list?format=txt&limit=50&protocol=http");
    CHECK(!hproxy_list_url(url, sizeof(url), "ftp", NULL, 5));
    CHECK(!hproxy_list_url(url, sizeof(url), NULL, "D3", 5));
    CHECK(!hproxy_list_url(url, sizeof(url), NULL, "DEU", 5));
    CHECK(!hproxy_list_url(url, sizeof(url), NULL, NULL, 0));
    CHECK(!hproxy_list_url(url, sizeof(url), NULL, NULL, 101));
    CHECK(!hproxy_list_url(url, 20, NULL, NULL, 5)); /* does not fit */
}

static void proxy_lines(void) {
    char out[HPROXY_PROXY_MAX];
    CHECK(hproxy_proxy_from_line("1.2.3.4:8080", out, sizeof(out)) == HproxyLineProxy);
    CHECK_STR(out, "1.2.3.4:8080");
    CHECK(hproxy_proxy_from_line("  95.182.114.41:80\r\n", out, sizeof(out)) == HproxyLineProxy);
    CHECK_STR(out, "95.182.114.41:80");
    CHECK(hproxy_proxy_from_line("socks5://5.6.7.8:1080", out, sizeof(out)) == HproxyLineProxy);
    CHECK_STR(out, "socks5://5.6.7.8:1080");
    CHECK(hproxy_proxy_from_line("proxy.example.com:3128", out, sizeof(out)) == HproxyLineProxy);
    CHECK(hproxy_proxy_from_line("[2001:db8::1]:8080", out, sizeof(out)) == HproxyLineProxy);
    CHECK_STR(out, "[2001:db8::1]:8080");

    /* A line with a login never leaves the Flipper, in any of the shapes providers print. */
    CHECK(hproxy_proxy_from_line("user:pass@1.2.3.4:80", out, sizeof(out)) == HproxyLineLogin);
    CHECK(hproxy_proxy_from_line("1.2.3.4:80:user:pass", out, sizeof(out)) == HproxyLineLogin);
    CHECK(hproxy_proxy_from_line("http://u:p@host.example:80", out, sizeof(out)) == HproxyLineLogin);
    CHECK(hproxy_proxy_from_line("[2001:db8::1]:8080:u:p", out, sizeof(out)) == HproxyLineLogin);

    CHECK(hproxy_proxy_from_line("", out, sizeof(out)) == HproxyLineBlank);
    CHECK(hproxy_proxy_from_line("   \r\n", out, sizeof(out)) == HproxyLineBlank);
    CHECK(hproxy_proxy_from_line("# my proxies", out, sizeof(out)) == HproxyLineBlank);

    CHECK(hproxy_proxy_from_line("1.2.3.4", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line("1.2.3.4:", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line("1.2.3.4:0", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line("1.2.3.4:65536", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line("1.2.3.4:80 fast", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line("a\"b.example:80", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line(":8080", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line("1.2.3.4:80:x", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(hproxy_proxy_from_line("[2001:db8::1]8080", out, sizeof(out)) == HproxyLineInvalid);
    CHECK(
        hproxy_proxy_from_line(
            /* 85 characters: one more than the 79 a proxy line may have. */
            "a-very-long-host-name-that-goes-on-and-on-and-on-and-on.example.com.another.part:8080",
            out,
            sizeof(out)) == HproxyLineInvalid);
}

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
    const char* three[] = {"1.2.3.4:80", "5.6.7.8:3128", "[2001:db8::1]:8080"};
    CHECK(hproxy_check_payload(body, sizeof(body), three, 3, NULL) == 3);
    CHECK_STR(
        body,
        "{\"proxies\":[\"1.2.3.4:80\",\"5.6.7.8:3128\",\"[2001:db8::1]:8080\"],"
        "\"timeout_ms\":1500,\"retries\":0}");
    CHECK(hproxy_check_payload(body, sizeof(body), three, 1, "socks5") == 1);
    CHECK_STR(
        body,
        "{\"proxies\":[\"1.2.3.4:80\"],\"timeout_ms\":1500,\"retries\":0,\"protocols\":[\"socks5\"]}");
    CHECK(command_length(body) <= HPROXY_BOARD_COMMAND_MAX - 1);

    /* Thirty typical addresses: one batch takes at most HPROXY_BATCH_MAX, and fits. */
    const char* many[30];
    for(int i = 0; i < 30; i++)
        many[i] = "159.65.230.146:8888";
    CHECK(hproxy_check_payload(body, sizeof(body), many, 30, "http") == HPROXY_BATCH_MAX);
    CHECK(command_length(body) <= HPROXY_BOARD_COMMAND_MAX - 1);

    /* Long host names: fewer per batch, still inside the buffer. */
    const char* longer[10];
    for(int i = 0; i < 10; i++)
        longer[i] = "a-rather-long-proxy-host-name-number-one.provider-example.com:31280";
    size_t packed = hproxy_check_payload(body, sizeof(body), longer, 10, NULL);
    CHECK(packed >= 1 && packed < 10);
    CHECK(command_length(body) <= HPROXY_BOARD_COMMAND_MAX - 1);

    CHECK(hproxy_check_payload(body, sizeof(body), three, 0, NULL) == 0);
    CHECK(hproxy_check_payload_budget() > 300);
}

static void check_rows(void) {
    HproxyResult r;
    const char* alive =
        "{\"input\":\"213.188.192.1:80\",\"status\":\"alive\",\"ip\":\"213.188.192.1\",\"port\":80,"
        "\"exit_ip\":\"213.188.192.1\",\"alive\":true,\"protocols\":[\"http\"],\"supports_udp\":null,"
        "\"speed_mbps\":null,\"anonymity\":\"anonymous\",\"latency_ms\":55,\"country_code\":\"US\","
        "\"region\":\"Mississippi\",\"city\":null,\"asn\":40509,\"asn_org\":\"Fly.io, Inc.\","
        "\"is_datacenter\":true,\"error\":null,\"failure\":null}";
    CHECK(hproxy_parse_check_row(alive, &r) == HproxyRowResult);
    CHECK_STR(r.input, "213.188.192.1:80");
    CHECK(r.alive);
    CHECK(r.latency_ms == 55);
    CHECK_STR(r.country, "US");
    CHECK_STR(r.anonymity, "anonymous");
    CHECK_STR(r.status, "alive");

    char shown[96];
    hproxy_format_result(&r, shown, sizeof(shown));
    CHECK_STR(shown, "+ 213.188.192.1:80\n  US 55ms anonymous\n");

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
    CHECK_STR(r.anonymity, "");
    hproxy_format_result(&r, shown, sizeof(shown));
    CHECK_STR(shown, "- 198.51.100.7:8080\n  not checkable here\n");

    const char* dead =
        "{\"input\":\"184.75.221.82:3118\",\"status\":\"dead\",\"alive\":false,\"protocols\":[],"
        "\"latency_ms\":null,\"country_code\":\"CA\"}";
    CHECK(hproxy_parse_check_row(dead, &r) == HproxyRowResult);
    hproxy_format_result(&r, shown, sizeof(shown));
    CHECK_STR(shown, "- 184.75.221.82:3118\n  dead\n");

    /* Keys in any order, nested values before them, spaces around. */
    const char* shuffled =
        " { \"protocols\" : [\"http\",{\"x\":[1,2]}] , \"alive\" : true , \"input\" : \"1.1.1.1:80\" } ";
    CHECK(hproxy_parse_check_row(shuffled, &r) == HproxyRowResult);
    CHECK_STR(r.input, "1.1.1.1:80");
    CHECK(r.alive);
    hproxy_format_result(&r, shown, sizeof(shown));
    CHECK_STR(shown, "+ 1.1.1.1:80\n  alive\n");

    CHECK(hproxy_parse_check_row("{\"_event\":\"end\",\"done\":1,\"duration_ms\":0,\"total\":1}", &r) == HproxyRowEnd);
    CHECK(hproxy_parse_check_row("{\"_event\":\"progress\",\"done\":3}", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("not json", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("{}", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("{\"input\":", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("{\"alive\":true}", &r) == HproxyRowOther);
    CHECK(hproxy_parse_check_row("[\"input\",\"x\"]", &r) == HproxyRowOther);
}

static void board_lines(void) {
    CHECK(hproxy_board_line("[GET/SUCCESS]{\"Status-Code\":200,\"Content-Length\":53}"));
    CHECK(hproxy_board_line("[POST/END]"));
    CHECK(hproxy_board_line("[ERROR] WiFi not connected."));
    CHECK(hproxy_board_line("[PONG]"));
    CHECK(!hproxy_board_line("[2001:db8::1]:8080"));
    CHECK(!hproxy_board_line("213.188.192.1:80"));
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
    CHECK(hproxy_board_status("213.188.192.1:80") == -1);
}

int main(void) {
    the_list_url();
    proxy_lines();
    check_payloads();
    check_rows();
    board_lines();
    if(failures) {
        printf("%d of %d checks failed\n", failures, checks);
        return 1;
    }
    printf("all %d checks passed\n", checks);
    return 0;
}
