"""Chrome through the rotating proxy with Selenium: three visits, each from the next proxy.

Chrome's --proxy-server takes no login, which is what hproxy gives it, whatever proxies with
logins sit behind it.

Start the proxy first:  hproxy connect --file proxies.txt --background
Then:                   pip install selenium
                        python selenium_example.py
"""

from selenium import webdriver
from selenium.webdriver.common.by import By

PROXY = "http://127.0.0.1:8080"  # where hproxy connect listens

options = webdriver.ChromeOptions()
options.add_argument(f"--proxy-server={PROXY}")
options.add_argument("--headless=new")

for i in range(1, 4):
    # A new browser opens its own connections, so it goes out through the next proxy.
    # Keep one browser when you want to stay on the same address.
    driver = webdriver.Chrome(options=options)
    try:
        driver.get("https://hproxy.com/cdn-cgi/trace")
        text = driver.find_element(By.TAG_NAME, "body").text
    finally:
        driver.quit()
    seen = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    print(f"{i}: ip={seen['ip']} loc={seen['loc']}")
