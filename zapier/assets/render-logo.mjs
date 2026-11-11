// Renders assets/icon.svg (HProxy's mark from hproxy.com/icon.svg, no app name in it) to a transparent square PNG for
// Zapier's branding (512x512 or larger), in a throwaway tab of the clean Chrome on port 9471.
//   node assets/render-logo.mjs [size=512]
import { readFileSync, writeFileSync } from "node:fs";
import { CDP, sleep } from "file:///D:/dev_0_claude_tools/seo/capture/cdp.mjs";

const size = Number(process.argv[2] || 512);
const dir = new URL(".", import.meta.url);
const svg = readFileSync(new URL("icon.svg", dir), "utf8").replace(/width="64" height="64"/, `width="${size}" height="${size}"`);
const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`;
const tab = await (await fetch("http://127.0.0.1:9471/json/new?about:blank", { method: "PUT" })).json();
const c = await new CDP(tab.webSocketDebuggerUrl).open();
try {
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await c.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await c.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
  await sleep(1500);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  const out = new URL(`logo-${size}.png`, dir);
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`${out.pathname} (${Buffer.from(data, "base64").length} bytes)`);
} finally {
  c.close();
  await fetch(`http://127.0.0.1:9471/json/close/${tab.id}`).catch(() => {});
}
