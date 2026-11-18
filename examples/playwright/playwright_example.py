"""A browser through the rotating proxy with Playwright for Python: three visits, each from the
next proxy. The browser gets a proxy with no login (hproxy's), whatever proxies with logins sit
behind it.

Start the proxy first:  hproxy connect --file proxies.txt --background
Then:                   pip install playwright
                        playwright install chromium
                        python playwright_example.py
"""

from playwright.sync_api import sync_playwright

PROXY = "http://127.0.0.1:8080"  # where hproxy connect listens

with sync_playwright() as p:
    browser = p.chromium.launch(proxy={"server": PROXY})
    try:
        for i in range(1, 4):
            # A new context opens its own connections, so it goes out through the next proxy.
            # Keep one context when you want to stay on the same address.
            context = browser.new_context()
            page = context.new_page()
            page.goto("https://hproxy.com/cdn-cgi/trace")
            text = page.inner_text("body")
            seen = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
            print(f"{i}: ip={seen['ip']} loc={seen['loc']}")
            context.close()
    finally:
        browser.close()
