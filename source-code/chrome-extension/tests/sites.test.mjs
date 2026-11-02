// sites.js: which sites use the proxy, read the way the other apps read it.
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../sites.js");
const { read, covers, bypassRules, onlyScript } = globalThis.HPROXY_SITES;

test("people write names, links, wildcards and addresses", () => {
  const { sites, wrong } = read("example.com, https://www.example.org/a?b=1\n*.example.net:8443 user@example.io 192.0.2.7 198.51.100.0/24");
  assert.deepEqual(sites, ["example.com", "www.example.org", "example.net", "example.io", "192.0.2.7", "198.51.100.0/24"]);
  assert.deepEqual(wrong, []);
});

test("what is not a site is said, nothing is dropped silently", () => {
  assert.deepEqual(read("example.com banana").wrong, ["banana"]);
  assert.deepEqual(read("").sites, []);
});

test("a name covers everything under it, at a dot", () => {
  assert.ok(covers("hproxy.com", "probe.hproxy.com"));
  assert.ok(covers("hproxy.com", "hproxy.com"));
  assert.ok(!covers("proxy.com", "hproxy.com"));
});

test("Chrome's bypass list gets a name and what is under it", () => {
  assert.deepEqual(bypassRules(["example.com", "192.0.2.7", "198.51.100.0/24"]), ["example.com", "*.example.com", "192.0.2.7", "198.51.100.0/24"]);
});

/** The script run the way Chrome runs it. */
function run(script, host) {
  const dnsDomainIs = (h, d) => h.endsWith(d);
  const toNumber = (ip) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
  const isInNet = (h, net, mask) => {
    const m = toNumber(mask);
    return (toNumber(h) & m) >>> 0 === (toNumber(net) & m) >>> 0;
  };
  return new Function("dnsDomainIs", "isInNet", `${script}\nreturn FindProxyForURL;`)(dnsDomainIs, isInNet)(`https://${host}/`, host);
}

test("only the sites named go through the proxy", () => {
  const script = onlyScript("mark", "PROXY 198.51.100.7:8080", ["example.com", "192.0.2.0/24"], "probe.hproxy.com");
  assert.equal(run(script, "example.com"), "PROXY 198.51.100.7:8080");
  assert.equal(run(script, "www.example.com"), "PROXY 198.51.100.7:8080");
  assert.equal(run(script, "192.0.2.9"), "PROXY 198.51.100.7:8080");
  assert.equal(run(script, "example.org"), "DIRECT");
  assert.equal(run(script, "198.51.100.9"), "DIRECT");
  assert.equal(run(script, "probe.hproxy.com"), "PROXY 198.51.100.7:8080", "the connection's own test always goes through it");
});
