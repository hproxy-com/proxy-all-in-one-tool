// The engine's doors (proxy-engine/hproxy-mobile/src/ffi.rs), for Swift.

#include <stdbool.h>
#include <stddef.h>

char *hproxy_init(const char *data, bool tunnel);
char *hproxy_call(const char *method, const char *args);
char *hproxy_poll(int timeout_ms);
void hproxy_free(char *text);

typedef void (*hproxy_write)(void *context, const unsigned char *packet, size_t length);
char *hproxy_tunnel_start(hproxy_write write, void *context, bool through_proxy);
void hproxy_tunnel_packet(const unsigned char *packet, size_t length);
void hproxy_tunnel_stop(void);
