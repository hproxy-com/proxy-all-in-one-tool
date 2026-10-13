// Our own gateways' HTTP twin of a SOCKS5 port (gateways.js), which the popup
// uses for a SOCKS5 line with a login: Chrome cannot send a SOCKS login.
import assert from "node:assert/strict";
import { test } from "node:test";
import { httpTwinPort } from "../gateways.js";

test("our SOCKS5 ports map to the same gateway's HTTP port", () => {
  assert.equal(httpTwinPort("mobile-gb.hproxy.com", 1080), 8080);
  assert.equal(httpTwinPort("gw.hproxy.com", 9696), 6969);
  assert.equal(httpTwinPort("gw-eu.hproxy.com", "9696"), 6969);
  assert.equal(httpTwinPort("premium.hproxy.com", 11000), 9000);
  assert.equal(httpTwinPort("premium.hproxy.com", 12000), 10000);
  assert.equal(httpTwinPort("premium.hproxy.com", 12010), 10010);
});

test("names are read the way Chrome hands them back", () => {
  assert.equal(httpTwinPort("Mobile-GB.HProxy.com", 1080), 8080);
  assert.equal(httpTwinPort("mobile-gb.hproxy.com.", 1080), 8080);
});

test("an HTTP port, another port or anyone else's host is left alone", () => {
  assert.equal(httpTwinPort("mobile-gb.hproxy.com", 8080), null);
  assert.equal(httpTwinPort("gw.hproxy.com", 6969), null);
  assert.equal(httpTwinPort("premium.hproxy.com", 12011), null);
  assert.equal(httpTwinPort("premium.hproxy.com", 10000), null);
  assert.equal(httpTwinPort("proxy.example.com", 1080), null);
  assert.equal(httpTwinPort("198.51.100.7", 1080), null);
  assert.equal(httpTwinPort("", 1080), null);
});
