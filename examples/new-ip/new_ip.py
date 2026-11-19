"""A new IP when your script decides, from Python with nothing to install (hproxy 0.4.9 and newer).

Start the proxy so it stays on one proxy until asked:
    hproxy connect --file proxies.txt --rotate on-failure --background
Then:
    python new_ip.py
"""

import json
import urllib.request

CONTROL = "http://127.0.0.1:8080/hproxy"  # the proxy's own address, then /hproxy


def control(page: str, method: str = "GET") -> dict:
    request = urllib.request.Request(f"{CONTROL}/{page}", method=method)
    # A switch to a fresh free exit can take a while; to the next proxy of a list it is instant.
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


now = control("status")
print(f"now:   proxy {now['member']} of {now['members']}, {now['upstream']}")
after = control("new-ip", "POST")  # the open connections end, the next request goes out the new way
print(f"after: proxy {after['member']} of {after['members']}, {after['upstream']}")
