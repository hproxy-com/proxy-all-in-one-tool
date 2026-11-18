"""Three requests through the rotating proxy with nothing to install (Python's own urllib).

Start the proxy first:  hproxy connect --file proxies.txt --background
Then:                   python urllib_example.py
"""

import urllib.request

PROXY = "http://127.0.0.1:8080"  # where hproxy connect listens

opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))


def trace() -> str:
    # urllib opens a new connection for every request, and every new connection goes out
    # through the next proxy.
    with opener.open("https://hproxy.com/cdn-cgi/trace", timeout=30) as response:
        text = response.read().decode()
    seen = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    return f"ip={seen['ip']} loc={seen['loc']}"


for i in range(1, 4):
    print(f"{i}: {trace()}")
