// test-proxy.mjs: a small HTTP proxy for trying the app on an emulator or a phone, never for use.
// It writes down every site it is asked for, so a test can see what went through it.
// Run from desktop-app/:
//
//   node scripts/test-proxy.mjs [port] [user:password]
//
// It listens on 127.0.0.1 only (so Windows asks no firewall question), which the Android emulator
// reaches as 10.0.2.2: the proxy line to paste in the app is `10.0.2.2:<port>` (or
// `user:password@10.0.2.2:<port>` with a login). It speaks CONNECT (every https site) and plain
// http, like the proxies people buy. Node's own modules only.
import { createServer, request } from "node:http";
import { connect } from "node:net";

const port = Number(process.argv[2] ?? 3128);
const login = process.argv[3];
const expected = login ? `Basic ${Buffer.from(login).toString("base64")}` : null;

/** One line per request: the time, the method and where to. */
function note(method, target, outcome) {
  console.log(`${new Date().toISOString()} ${method} ${target} ${outcome}`);
}

function allowed(req, refuse) {
  if (!expected || req.headers["proxy-authorization"] === expected) return true;
  refuse();
  return false;
}

const server = createServer((req, res) => {
  if (!allowed(req, () => res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="test"' }).end())) {
    note(req.method, req.url, "407");
    return;
  }
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end("a proxy request needs the whole URL");
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (e) => {
    note(req.method, url.host, `failed: ${e.message}`);
    res.writeHead(502).end();
  });
  req.pipe(upstream);
  note(req.method, url.host, "ok");
});

server.on("connect", (req, socket, head) => {
  if (!allowed(req, () => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\n\r\n"))) {
    note("CONNECT", req.url, "407");
    return;
  }
  const [host, p] = req.url.split(/:(?=\d+$)/);
  const site = connect(Number(p ?? 443), host.replace(/^\[|\]$/g, ""), () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) site.write(head);
    site.pipe(socket);
    socket.pipe(site);
    note("CONNECT", req.url, "ok");
  });
  site.on("error", (e) => {
    note("CONNECT", req.url, `failed: ${e.message}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  socket.on("error", () => site.destroy());
});

server.listen(port, "127.0.0.1", () => console.log(`test proxy on port ${port}${login ? " with a login" : ""}; from the emulator: 10.0.2.2:${port}`));
