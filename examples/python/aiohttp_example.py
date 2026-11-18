"""Three requests through the rotating proxy with aiohttp, each going out through the next proxy.

Start the proxy first:  hproxy connect --file proxies.txt --background
Then:                   pip install aiohttp
                        python aiohttp_example.py
"""

import asyncio

import aiohttp

PROXY = "http://127.0.0.1:8080"  # where hproxy connect listens


async def main() -> None:
    # force_close: every request opens its own connection, so every request goes out through
    # the next proxy. Leave the connector as it is to keep one connection and one address.
    connector = aiohttp.TCPConnector(force_close=True)
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        for i in range(1, 4):
            async with session.get("https://hproxy.com/cdn-cgi/trace", proxy=PROXY) as response:
                text = await response.text()
            seen = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
            print(f"{i}: ip={seen['ip']} loc={seen['loc']}")


asyncio.run(main())
