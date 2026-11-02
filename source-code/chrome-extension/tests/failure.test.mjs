// failure.js: why a proxy failed, by its name, in the apps' words.
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../failure.js");
const { TIMED_OUT, ofChrome, ofStatus, parts } = globalThis.HPROXY_FAILURE;

test("Chrome's codes are named", () => {
  assert.equal(ofChrome("net::ERR_CONNECTION_TIMED_OUT"), TIMED_OUT);
  assert.equal(ofChrome("net::ERR_TIMED_OUT"), TIMED_OUT);
  assert.match(ofChrome("net::ERR_PROXY_CONNECTION_FAILED"), /^Connection refused: /);
  assert.match(ofChrome("net::ERR_NAME_NOT_RESOLVED"), /^Address not found: /);
  assert.match(ofChrome("net::ERR_PROXY_AUTH_UNSUPPORTED"), /^Login refused: /);
  assert.match(ofChrome("net::ERR_TUNNEL_CONNECTION_FAILED"), /^Proxy error: /);
  assert.equal(ofChrome("net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE"), "Proxy error: host unreachable");
  assert.match(ofChrome("net::ERR_CERT_AUTHORITY_INVALID"), /^Bad certificate: /);
  assert.match(ofChrome("net::ERR_EMPTY_RESPONSE"), /^Connection closed: /);
  assert.match(ofChrome("net::ERR_INTERNET_DISCONNECTED"), /^No internet: /);
});

test("what cannot be named stays unsaid", () => {
  assert.equal(ofChrome("net::ERR_ABORTED"), null);
  assert.equal(ofChrome(""), null);
  assert.equal(ofChrome(undefined), null);
});

test("words part into the error's name and what it means", () => {
  assert.deepEqual(parts(TIMED_OUT), { name: "Timed out", detail: "The proxy did not answer" });
  assert.deepEqual(parts(ofStatus(503)), { name: "Error 503", detail: "The page answered with an error" });
  assert.deepEqual(parts("Nothing came back"), { name: "", detail: "Nothing came back" });
  assert.deepEqual(parts(null), { name: "", detail: "" });
});
