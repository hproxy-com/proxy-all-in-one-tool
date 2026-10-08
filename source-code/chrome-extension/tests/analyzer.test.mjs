// The analyzer's grading rules, which mirror the checking engine's.
// Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeEcho, wireIp, publicIp, medianMs, verdictFor, dnsVerdict, localeVerdict, madeUpName, LEAK_HEADERS } from "../analyzer.js";

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

test("the DNS test uses a fresh name nobody can guess", () => {
  const a = madeUpName();
  assert.match(a, /^[a-z0-9]{20}$/);
  assert.notEqual(a, madeUpName());
});

test("the DNS row names the resolver and compares its country with the exit", () => {
  const google = (country) => ({ ip: "198.51.100.53", geo: { asn_org: "Google LLC", country } });
  assert.deepEqual(
    [dnsVerdict([google("DE")], "DE").status, dnsVerdict([google("DE")], "DE").headline],
    ["ok", "Google LLC, DE"],
  );
  const elsewhere = dnsVerdict([google("DE")], "NL");
  assert.equal(elsewhere.status, "warn");
  assert.match(elsewhere.detail, /in DE, your exit in NL/);
});

test("the DNS row never passes what it did not see", () => {
  assert.equal(dnsVerdict([], "DE").status, "unknown");
  assert.equal(dnsVerdict([{ ip: "192.0.2.1", geo: null }], "DE").status, "ok", "a resolver without a country is named, not judged");
  assert.equal(dnsVerdict([{ ip: "192.0.2.1", geo: null }], "DE").headline, "192.0.2.1");
});

test("the language row judges by the first language, the one sites compare", () => {
  assert.equal(localeVerdict(["en-US", "en"], "US").status, "ok");
  const german = localeVerdict(["de-DE", "de", "en-US"], "US");
  assert.equal(german.status, "warn", "English further down does not make a German browser look American");
  assert.match(german.detail, /de-DE content first, from a US address/);
  assert.equal(localeVerdict(["en", "de-DE"], "US").status, "unknown", "a first language with no country contradicts nothing");
  assert.equal(localeVerdict([], "US").status, "unknown");
});
