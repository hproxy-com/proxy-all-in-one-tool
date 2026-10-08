#!/usr/bin/env node
/* A live smoke test: speak the protocol to the real server over stdio and
   call every tool against the real API. No mocks — the point is to prove the
   three endpoints answer and the shapes are what the tool descriptions
   promise. Run: node test.mjs */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(HERE, "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const waiting = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const r = waiting.get(msg.id);
    if (r) {
      waiting.delete(msg.id);
      r(msg);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));

let id = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const mine = ++id;
    waiting.set(mine, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
    setTimeout(() => waiting.has(mine) && (waiting.delete(mine), reject(new Error(`${method} timed out`))), 45000);
  });

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
check("initialize names the server", init.result?.serverInfo?.name === "hproxy", JSON.stringify(init.result?.serverInfo));

const list = await call("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
check("three tools listed", names.join(",") === "ip_lookup,proxy_check,proxy_list", names.join(","));
check("every tool has a schema", (list.result?.tools ?? []).every((t) => t.inputSchema?.type === "object"));

const listed = await call("tools/call", { name: "proxy_list", arguments: { country: "de", limit: 3 } });
const listOut = JSON.parse(listed.result?.content?.[0]?.text ?? "{}");
check("proxy_list returns proxies", Array.isArray(listOut.proxies) && listOut.proxies.length > 0, JSON.stringify(listOut).slice(0, 200));
check("proxy_list rows carry ip and port", Boolean(listOut.proxies?.[0]?.ip && listOut.proxies?.[0]?.port));
check("proxy_list honours the country filter", (listOut.proxies ?? []).every((p) => !p.country_code || p.country_code.toLowerCase() === "de"));

const first = listOut.proxies?.[0];
if (first) {
  const checked = await call("tools/call", { name: "proxy_check", arguments: { proxies: [`${first.ip}:${first.port}`] } });
  const checkOut = JSON.parse(checked.result?.content?.[0]?.text ?? "{}");
  check("proxy_check answers with a verdict", typeof checkOut.results?.[0]?.alive === "boolean", JSON.stringify(checkOut).slice(0, 200));
}

const looked = await call("tools/call", { name: "ip_lookup", arguments: { ips: ["8.8.8.8"] } });
const ipOut = JSON.parse(looked.result?.content?.[0]?.text ?? "{}");
check("ip_lookup resolves a network", Boolean(ipOut.asn || ipOut.asn_org || ipOut.country_code), JSON.stringify(ipOut).slice(0, 200));

const bad = await call("tools/call", { name: "proxy_check", arguments: { proxies: [] } });
check("an empty call is an isError result, not a crash", bad.result?.isError === true);

const missing = await call("tools/call", { name: "nope", arguments: {} });
check("an unknown tool is a protocol error", Boolean(missing.error));

child.kill();
console.log(failures ? `\n${failures} failed` : "\nall green");
process.exit(failures ? 1 : 0);
