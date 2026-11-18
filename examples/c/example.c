/* Three requests through the rotating proxy with libcurl, each going out through the next proxy.
 * C++ uses libcurl the same way.
 *
 * Start the proxy first:  hproxy connect --file proxies.txt --background
 * Then:                   cc example.c -lcurl -o example && ./example
 */
#include <curl/curl.h>
#include <stdio.h>
#include <string.h>

#define PROXY "http://127.0.0.1:8080" /* where hproxy connect listens */

struct answer {
    char text[4096];
    size_t len;
};

static size_t keep(char *data, size_t size, size_t count, void *user) {
    struct answer *a = user;
    size_t n = size * count;
    size_t room = sizeof(a->text) - 1 - a->len;
    memcpy(a->text + a->len, data, n < room ? n : room);
    a->len += n < room ? n : room;
    a->text[a->len] = '\0';
    return n;
}

/* The value after "<key>=" on its own line, or "?". */
static const char *field(const char *text, const char *key, char *out, size_t size) {
    char want[16];
    snprintf(want, sizeof(want), "\n%s=", key);
    const char *at = strstr(text, want);
    if (!at) return "?";
    at += strlen(want);
    size_t n = strcspn(at, "\n");
    snprintf(out, size, "%.*s", (int)n, at);
    return out;
}

int main(void) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    for (int i = 1; i <= 3; i++) {
        /* A new easy handle opens a new connection: the next proxy. Reuse one handle to stay on
         * the same address. */
        CURL *curl = curl_easy_init();
        struct answer a = {.len = 0};
        a.text[0] = '\n'; /* so the first line also starts after a newline */
        a.len = 1;
        curl_easy_setopt(curl, CURLOPT_URL, "https://hproxy.com/cdn-cgi/trace");
        curl_easy_setopt(curl, CURLOPT_PROXY, PROXY);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, keep);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &a);
        CURLcode res = curl_easy_perform(curl);
        curl_easy_cleanup(curl);
        if (res != CURLE_OK) {
            fprintf(stderr, "%d: %s\n", i, curl_easy_strerror(res));
            return 1;
        }
        char ip[64], loc[16];
        printf("%d: ip=%s loc=%s\n", i, field(a.text, "ip", ip, sizeof(ip)), field(a.text, "loc", loc, sizeof(loc)));
    }
    curl_global_cleanup();
    return 0;
}
