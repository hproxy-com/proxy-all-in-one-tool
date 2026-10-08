// The engine's own parser tests (line.rs in the hproxy-checker app), run
// against the JavaScript port. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine, isHostname } from "../line.js";

const line = (s) => {
  const r = parseLine(s);
  assert.ok(!r.error, `${JSON.stringify(s)} failed: ${r.error}`);
  return r;
};
const auth = (r) => (r.username || r.password ? [r.username, r.password] : null);

test("plain host:port", () => {
  const l = line("203.0.113.20:8080");
  assert.deepEqual([l.host, l.port, auth(l), l.scheme], ["203.0.113.20", 8080, null, null]);
});

test("the colon shape most sellers print", () => {
  const l = line("198.51.100.44:3128:bob:secret");
  assert.deepEqual(auth(l), ["bob", "secret"]);
  assert.equal(l.port, 3128);
});

test("URL auth and reverse auth", () => {
  let l = line("bob:secret@198.51.100.44:3128");
  assert.equal(l.host, "198.51.100.44");
  assert.deepEqual(auth(l), ["bob", "secret"]);
  l = line("1.2.3.4:8080@myuser:mypass");
  assert.equal(l.host, "1.2.3.4");
  assert.deepEqual(auth(l), ["myuser", "mypass"]);
});

test("schemes are kept as hints", () => {
  assert.equal(line("socks5://192.0.2.8:1080").scheme, "socks5");
  assert.equal(line("socks5h://u:p@h.example.com:1080").scheme, "socks5");
  assert.equal(line("socks4://1.2.3.4:1080").scheme, "socks4");
  assert.equal(line("http://bob:secret@1.2.3.4:80").scheme, "http");
  assert.equal(line("https://u:p@h.example.com:1").scheme, "http", "https:// for a proxy means plain HTTP");
  assert.equal(line("1.2.3.4:80").scheme, null);
  assert.equal(line("shadowsocks://1.2.3.4:80").scheme, null, "an unknown scheme is dropped, never fatal");
});

test("CSV, pipes, tabs and spaces", () => {
  for (const s of ["1.2.3.4,8080,myuser,mypass", "1.2.3.4|8080|myuser|mypass", "1.2.3.4\t8080\tmyuser\tmypass", "1.2.3.4 8080 myuser mypass"]) {
    const l = line(s);
    assert.deepEqual([l.host, l.port], ["1.2.3.4", 8080], s);
    assert.deepEqual(auth(l), ["myuser", "mypass"], s);
  }
});

test("login first", () => {
  const l = line("myuser:mypass:1.2.3.4:8080");
  assert.deepEqual([l.host, l.port], ["1.2.3.4", 8080]);
  assert.deepEqual(auth(l), ["myuser", "mypass"]);
});

test("passwords with colons, at signs and spaces survive", () => {
  assert.deepEqual(auth(line("h.example.com:8080:user:9f:a2:c1")), ["user", "9f:a2:c1"]);
  assert.deepEqual(auth(line("1.2.3.4:8080:user:9f:a2:c1")), ["user", "9f:a2:c1"]);
  let l = line("user:p@ss@198.51.100.7:8080");
  assert.deepEqual(auth(l), ["user", "p@ss"]);
  assert.equal(l.host, "198.51.100.7");
  assert.deepEqual(auth(line("user:a:b@1.2.3.4:8080")), ["user", "a:b"]);
  assert.deepEqual(auth(line("1.2.3.4:8080:user:open sesame")), ["user", "open sesame"]);
});

test("gateway hostnames", () => {
  assert.equal(line("gate.example.net:30").host, "gate.example.net");
  const l = line("user-country-us:pass1234@gate.example.net:30");
  assert.equal(l.host, "gate.example.net");
  assert.deepEqual(auth(l), ["user-country-us", "pass1234"]);
  assert.equal(line("localhost:3128").host, "localhost");
});

test("bracketed and unbracketed IPv6", () => {
  let l = line("[2001:db8::1]:8080");
  assert.deepEqual([l.host, l.port, auth(l)], ["2001:db8::1", 8080, null]);
  assert.deepEqual(auth(line("[2a02:c207:3020:3781::b2]:8080:u:p")), ["u", "p"]);
  l = line("u:p@[2a02:c207:3020:3781::b2]:8080");
  assert.equal(l.host, "2a02:c207:3020:3781::b2");
  assert.equal(line("[::1]:3128").host, "::1");
  l = line("2a02:c207:3020:3781::b2:8080");
  assert.deepEqual([l.host, l.port], ["2a02:c207:3020:3781::b2", 8080]);
  l = line("2a02:c207:3020:3781::b2:8080:u:p");
  assert.deepEqual(auth(l), ["u", "p"]);
});

test("scheme, auth and path all stripped", () => {
  const l = line("http://user:pass@1.2.3.4:8080/echo?x=1");
  assert.deepEqual([l.host, l.port], ["1.2.3.4", 8080]);
  assert.deepEqual(auth(l), ["user", "pass"]);
  assert.equal(line("1.2.3.4:8080/some/path").port, 8080);
});

test("ambiguous leftovers never guess a login", () => {
  assert.deepEqual(auth(line("1.2.3.4:8080:a:b:c")), ["a", "b:c"]);
  assert.equal(auth(line("1.2.3.4 8080 a b c")), null, "three leftovers are not a login");
});

test("a byte-order mark or zero-width edge is ignored", () => {
  const l = line("\uFEFF198.51.100.7:8080:user:pass");
  assert.deepEqual([l.host, l.port], ["198.51.100.7", 8080]);
  assert.equal(line("\u200Bgate.example.net:30\u200B").host, "gate.example.net");
  assert.ok(parseLine("\uFEFF").error, "a lone mark is an empty line");
});

test("a numeric password never turns the login into the host", () => {
  let l = line("user1:12345:gate.example.com:8000");
  assert.deepEqual([l.host, l.port, auth(l)], ["gate.example.com", 8000, ["user1", "12345"]]);
  l = line("user1:12345:198.51.100.7:8080");
  assert.deepEqual([l.host, l.port], ["198.51.100.7", 8080]);
  l = line("gate.example.com:8000:12345:67890");
  assert.deepEqual([l.host, l.port, auth(l)], ["gate.example.com", 8000, ["12345", "67890"]]);
  assert.deepEqual([line("squid:3128:user:1234").host, line("squid:3128:user:1234").port], ["squid", 3128]);
  l = line("user1 12345 gate.example.com 8000");
  assert.deepEqual([l.host, l.port, auth(l)], ["gate.example.com", 8000, ["user1", "12345"]]);
});

test("junk is refused with a reason", () => {
  assert.ok(parseLine("").error);
  assert.ok(parseLine("   ").error);
  assert.match(parseLine("# comment").error, /comment/);
  assert.ok(parseLine("not a proxy").error);
  assert.match(parseLine("1.2.3.4").error, /no port/);
  assert.match(parseLine("1.2.3.4:notaport").error, /port number/);
  assert.equal(auth(line("h.example.com:1:user")), null, "one leftover is never a login");
  assert.ok(parseLine("999.999.999.999:80").error);
  assert.ok(parseLine("1.2.3.4:0").error);
  assert.ok(parseLine("1.2.3.4:99999").error);
  assert.ok(parseLine(`1.2.3.4:8080:${"a".repeat(600)}`).error);
});

test("a malformed address is not a hostname", () => {
  assert.equal(isHostname("1.2.3.999"), false);
  assert.equal(isHostname("192.168.1.1"), false);
  assert.equal(isHostname("gate.example.com"), true);
  assert.equal(isHostname("localhost"), true);
  assert.equal(isHostname("-bad.example.com"), false);
  assert.equal(isHostname("squid"), true);
  assert.equal(isHostname("8080"), false);
});

// The shared list (proxy-engine/hproxy-probe/tests/fixtures/proxy-lines.json): the
// engine, this port and the desktop app read every line of it the same way,
// or refuse it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("the shared corpus reads exactly like the engine", () => {
  const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../proxy-engine/hproxy-probe/tests/fixtures/proxy-lines.json", import.meta.url)), "utf8"));
  assert.ok(corpus.length >= 90, `the corpus shrank to ${corpus.length} cases`);
  for (const c of corpus) {
    const r = parseLine(c.line);
    const name = `${JSON.stringify(c.line)} (${c.why})`;
    if ("error" in c) {
      assert.ok(r.error, `${name} should be refused, got ${JSON.stringify(r)}`);
      assert.ok(r.error.includes(c.error), `${name}: "${r.error}" should mention "${c.error}"`);
      continue;
    }
    assert.ok(!r.error, `${name} failed: ${r.error}`);
    assert.equal(r.host, c.host, `${name} host`);
    assert.equal(r.port, c.port, `${name} port`);
    assert.deepEqual(auth(r), "user" in c ? [c.user, c.pass ?? ""] : null, `${name} login`);
    assert.equal(r.scheme, c.scheme ?? null, `${name} scheme`);
  }
});
