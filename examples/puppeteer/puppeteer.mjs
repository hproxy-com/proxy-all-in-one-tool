// Chrome through the rotating proxy with Puppeteer: three visits, each from the next proxy.
// Chrome's --proxy-server takes no login, which is what hproxy gives it, whatever proxies with
// logins sit behind it.
//
// Start the proxy first:  hproxy connect --file proxies.txt --background
// Then:                   npm install
//                         node puppeteer.mjs
import puppeteer from "puppeteer";

const PROXY = "http://127.0.0.1:8080"; // where hproxy connect listens

const browser = await puppeteer.launch({ args: [`--proxy-server=${PROXY}`] });
try {
  for (let i = 1; i <= 3; i++) {
    // A new browser context opens its own connections, so it goes out through the next proxy.
    // Keep one context when you want to stay on the same address.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.goto("https://hproxy.com/cdn-cgi/trace");
    const text = await page.evaluate(() => document.body.innerText);
    const seen = Object.fromEntries(text.trim().split("\n").map((line) => line.split("=")));
    console.log(`${i}: ip=${seen.ip} loc=${seen.loc}`);
    await context.close();
  }
} finally {
  await browser.close();
}
