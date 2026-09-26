// The analyzer's grading rules, which mirror the checking engine's.
// Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEcho, wireIp, publicIp, medianMs, verdictFor, LEAK_HEADERS } from "../analyzer.js";

const ME = "198.51.100.23"; // this browser's own address, in the tests
const EXIT = "203.0.113.9"; // where the proxy leaves

test("our own edge headers are never a leak", () => {
  // What the plain judge sends back through an elite proxy: only our nginx's
  // own peer header and the probe's nonce.
  const echo = { ip: EXIT, peer_ip: EXIT, headers: { host: "echo.example", "x-real-peer": EXIT, "x-hproxy-probe": "n1" } };
  assert.equal(gradeEcho(echo, [ME]).tier, "elite");
  assert.ok(!LEAK_HEADERS.includes("x-real-peer"));
  assert.ok(!LEAK_HEADERS.includes("x-hproxy-probe"));
});

test("a proxy that announces itself is anonymous", () => {
  const echo = { ip: EXIT, headers: { via: "1.1 squid", "x-real-peer": EXIT } };
  const g = gradeEcho(echo, [ME]);
  assert.equal(g.tier, "anonymous");
  assert.deepEqual(g.leaks, [{ name: "via", value: "1.1 squid" }]);
});

test("a proxy that forwards your address is transparent", () => {
  const echo = { ip: ME, headers: { "x-forwarded-for": ME, "x-real-peer": EXIT } };
  assert.equal(gradeEcho(echo, [ME]).tier, "transparent");
  // Inside a list of addresses, too.
  const chained = { ip: EXIT, headers: { "X-Forwarded-For": `10.0.0.1, ${ME}` } };
  assert.equal(gradeEcho(chained, [ME]).tier, "transparent");
});

test("without your own address, transparent cannot be proven", () => {
  const echo = { ip: ME, headers: {} };
  assert.equal(gradeEcho(echo, []).tier, "elite");
  assert.equal(gradeEcho({ ip: EXIT, headers: { via: "x" } }, []).tier, "anonymous");
});

test("the wire address reads through our edge's loopback", () => {
  assert.equal(wireIp({ ip: "127.0.0.1", headers: { "x-real-peer": EXIT } }), EXIT);
  assert.equal(wireIp({ ip: "", headers: { "x-real-peer": EXIT } }), EXIT);
  assert.equal(wireIp({ ip: "9.9.9.9", headers: { "x-real-peer": EXIT } }), "9.9.9.9");
});

test("only public addresses count as an exit", () => {
  assert.equal(publicIp(EXIT), EXIT);
  assert.equal(publicIp(`${EXIT}, 10.0.0.1`), EXIT, "first of a list");
  for (const bad of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.1.1", "100.64.0.1", "::1", "fe80::1", "fd00::1", "not an ip", ""]) {
    assert.equal(publicIp(bad), null, bad);
  }
  assert.equal(publicIp("2606:4700::1111"), "2606:4700::1111");
});

test("the round trip is a median, and nothing is not zero", () => {
  assert.equal(medianMs([300, 100, 200]), 200);
  assert.equal(medianMs([]), null);
});

test("a proxy that carries nothing is not working, never leaking", () => {
  // What a free exit that re-signs HTTPS looks like to the analyzer.
  const rows = [
    { label: "Exit address", status: "unknown" },
    { label: "Round trip", status: "bad", kind: "dead" },
  ];
  const v = verdictFor(rows);
  assert.equal(v.status, "bad");
  assert.equal(v.headline, "Not carrying traffic");
  // A real leak still comes first, and is named.
  const leak = verdictFor([{ label: "Header leaks", status: "bad" }, ...rows]);
  assert.equal(leak.headline, "1 thing is leaking");
  assert.equal(leak.detail, "Header leaks");
});

test("the verdict never calls unmeasured clean", () => {
  const rows = [
    { label: "Exit address", status: "ok" },
    { label: "DNS resolver", status: "unknown" },
  ];
  assert.equal(verdictFor(rows).status, "unknown");
  assert.equal(verdictFor([{ label: "Header leaks", status: "bad" }, ...rows]).status, "bad");
  assert.equal(verdictFor([{ label: "x", status: "skip" }]).status, "skip");
});
