// A new IP when your program decides, from Go (hproxy 0.4.9 and newer).
//
// Start the proxy so it stays on one proxy until asked:
//
//	hproxy connect --file proxies.txt --rotate on-failure --background
//
// Then:
//
//	go run main.go
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const control = "http://127.0.0.1:8080/hproxy" // the proxy's own address, then /hproxy

type answer struct {
	OK       bool   `json:"ok"`
	Error    string `json:"error"`
	Upstream string `json:"upstream"`
	Member   int    `json:"member"`
	Members  int    `json:"members"`
}

func ask(method, page string) answer {
	// The control page is this machine itself: no proxy on the way there.
	client := &http.Client{Timeout: 90 * time.Second, Transport: &http.Transport{Proxy: nil}}
	request, _ := http.NewRequest(method, control+"/"+page, nil)
	response, err := client.Do(request)
	if err != nil {
		panic(err)
	}
	defer response.Body.Close()
	var a answer
	if err := json.NewDecoder(response.Body).Decode(&a); err != nil {
		panic(err)
	}
	if !a.OK {
		panic(a.Error)
	}
	return a
}

func main() {
	now := ask("GET", "status")
	fmt.Printf("now:   proxy %d of %d, %s\n", now.Member, now.Members, now.Upstream)
	// The open connections end with the switch, so the next request goes out the new way.
	after := ask("POST", "new-ip")
	fmt.Printf("after: proxy %d of %d, %s\n", after.Member, after.Members, after.Upstream)
}
