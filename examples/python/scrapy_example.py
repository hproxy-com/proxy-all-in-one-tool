"""A Scrapy spider through the rotating proxy: three requests, each through the next proxy.

Start the proxy first:  hproxy connect --file proxies.txt --background
Then:                   pip install "scrapy>=2.13"
                        python scrapy_example.py

In a Scrapy project, the same two lines go into each Request (or a downloader middleware):
meta={"proxy": PROXY} and the Connection: close header.
"""

import scrapy
from scrapy.crawler import CrawlerProcess

PROXY = "http://127.0.0.1:8080"  # where hproxy connect listens


class TraceSpider(scrapy.Spider):
    name = "trace"

    async def start(self):
        for i in range(1, 4):
            yield scrapy.Request(
                f"https://hproxy.com/cdn-cgi/trace?n={i}",
                meta={"proxy": PROXY, "n": i},
                # Scrapy keeps a connection for the next request, and with it one proxy.
                # Closed after each answer, every request opens a new one: the next proxy.
                # Leave the header out to stay on the same address.
                headers={"Connection": "close"},
                dont_filter=True,
            )

    def parse(self, response):
        seen = dict(line.split("=", 1) for line in response.text.splitlines() if "=" in line)
        print(f"{response.meta['n']}: ip={seen['ip']} loc={seen['loc']}")


process = CrawlerProcess(
    settings={
        "LOG_LEVEL": "WARNING",
        "CONCURRENT_REQUESTS": 1,
        "ROBOTSTXT_OBEY": False,
    }
)
process.crawl(TraceSpider)
process.start()
