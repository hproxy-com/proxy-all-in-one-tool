"""Three requests through the rotating proxy with httpx, each going out through the next proxy.

Start the proxy first:  hproxy connect --file proxies.txt --background
Then:                   pip install httpx
                        python httpx_example.py
"""

import httpx

PROXY = "http://127.0.0.1:8080"  # where hproxy connect listens


def trace() -> str:
    # httpx.get opens a new client, and so a new connection, every time: the next proxy.
    # An httpx.Client keeps its connection, and with it one proxy: use one to stay on the
    # same address.
    text = httpx.get("https://hproxy.com/cdn-cgi/trace", proxy=PROXY, timeout=30).text
    seen = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    return f"ip={seen['ip']} loc={seen['loc']}"


for i in range(1, 4):
    print(f"{i}: {trace()}")
