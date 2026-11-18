// A Colly scraper through the rotating proxy: three pages, each through the next proxy.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   go mod tidy
//                         go run .
package main

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/gocolly/colly/v2"
)

const proxy = "http://127.0.0.1:8080" // where hproxy connect listens

func main() {
	proxyURL, err := url.Parse(proxy)
	if err != nil {
		panic(err)
	}
	c := colly.NewCollector(colly.AllowURLRevisit())
	// Without keep-alive every request opens its own connection, so every request goes out through
	// the next proxy. Turn keep-alive on to stay on the same address.
	c.WithTransport(&http.Transport{Proxy: http.ProxyURL(proxyURL), DisableKeepAlives: true})

	c.OnResponse(func(r *colly.Response) {
		seen := map[string]string{}
		for _, line := range strings.Split(string(r.Body), "\n") {
			if key, value, ok := strings.Cut(line, "="); ok {
				seen[key] = value
			}
		}
		fmt.Printf("%s: ip=%s loc=%s\n", r.Ctx.Get("n"), seen["ip"], seen["loc"])
	})

	for i := 1; i <= 3; i++ {
		ctx := colly.NewContext()
		ctx.Put("n", fmt.Sprint(i))
		if err := c.Request("GET", "https://hproxy.com/cdn-cgi/trace", nil, ctx, nil); err != nil {
			panic(err)
		}
	}
}
