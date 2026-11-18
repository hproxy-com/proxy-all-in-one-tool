// Three requests through the rotating proxy, each going out through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   go run main.go
package main

import (
	"bufio"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const proxy = "http://127.0.0.1:8080" // where hproxy connect listens; socks5://127.0.0.1:8080 works too

func main() {
	proxyURL, err := url.Parse(proxy)
	if err != nil {
		panic(err)
	}
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy: http.ProxyURL(proxyURL),
			// Go keeps a connection open and sends the next request over it, through the same
			// proxy. Without keep-alive every request opens its own connection: the next proxy.
			// Leave it on when you want to stay on the same address.
			DisableKeepAlives: true,
		},
	}
	for i := 1; i <= 3; i++ {
		resp, err := client.Get("https://hproxy.com/cdn-cgi/trace")
		if err != nil {
			panic(err)
		}
		seen := map[string]string{}
		lines := bufio.NewScanner(resp.Body)
		for lines.Scan() {
			if key, value, ok := strings.Cut(lines.Text(), "="); ok {
				seen[key] = value
			}
		}
		resp.Body.Close()
		fmt.Printf("%d: ip=%s loc=%s\n", i, seen["ip"], seen["loc"])
	}
}
