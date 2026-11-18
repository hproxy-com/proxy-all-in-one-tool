"""Three requests through the rotating proxy, each going out through the next proxy.

Start the proxy first:  hproxy connect --file proxies.txt --background
Then:                   pip install requests
                        python requests_example.py
"""

import requests

PROXY = "http://127.0.0.1:8080"  # where hproxy connect listens
# Over SOCKS5 instead: "socks5h://127.0.0.1:8080", after pip install "requests[socks]".


def trace() -> str:
    # requests.get opens a new connection every time, and every new connection goes out
    # through the next proxy. A requests.Session keeps its connection, and with it one proxy:
    # use a Session when you want to stay on the same address.
    text = requests.get(
        "https://hproxy.com/cdn-cgi/trace",
        proxies={"http": PROXY, "https": PROXY},
        timeout=30,
    ).text
    seen = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    return f"ip={seen['ip']} loc={seen['loc']}"


for i in range(1, 4):
    print(f"{i}: {trace()}")
