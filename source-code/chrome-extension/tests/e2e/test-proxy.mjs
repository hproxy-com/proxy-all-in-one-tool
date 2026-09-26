/* ============================================================
   A proxy of our own on 127.0.0.1, for the end-to-end run.

   Plays the parts a real customer's proxy plays, so the login path can
   be tested without anyone's account:
     - `user` + `pass` set: answers 407 until the right login arrives,
       like every paid proxy.
     - `refuse`: hosts it answers 403 for, like a proxy that blocks some
       sites while working fine for everything else.

   It leaves through THIS machine's own connection, so the analyzer
   rightly reports "your own address reaches sites" through it.
   ============================================================ */

import http from "node:http";
import net from "node:net";

export function startTestProxy({ user = "", pass = "", refuse = [] } = {}) {
  const stats = { challenges: 0, accepted: 0, refused: 0, tunnels: 0 };
  const expected = user ? `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` : null;
  /* rechallenge() makes the next request get a 407 in a NEW realm even with
     the right login. Chrome keeps logins per realm and sends a cached one
     unasked, so without this a second test on the same proxy never reaches
     the extension's login handler at all. */
  let realm = "hproxy-test";
  let forceChallenge = false;
  const authorised = (headers) => {
    if (expected && forceChallenge) {
      forceChallenge = false;
      return false;
    }
    return !expected || headers["proxy-authorization"] === expected;
  };
  const blocked = (host) => refuse.some((h) => host === h || host.endsWith(`.${h}`));

  const server = http.createServer((req, res) => {
    // Plain HTTP through a proxy: the request line carries the full URL.
    if (!authorised(req.headers)) {
      stats.challenges++;
      res.writeHead(407, { "Proxy-Authenticate": `Basic realm="${realm}"`, "Content-Length": "0" });
      return res.end();
    }
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (blocked(url.hostname)) {
      stats.refused++;
      res.writeHead(403, { "Content-Length": "0" });
      return res.end();
    }
    stats.accepted++;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^proxy-/i.test(k)));
    const upstream = http.request(
      { host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, socket, head) => {
    socket.on("error", () => {});
    if (!authorised(req.headers)) {
      stats.challenges++;
      socket.end(
        `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${realm}"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const i = req.url.lastIndexOf(":");
    const host = req.url.slice(0, i).replace(/^\[|\]$/g, "");
    const port = Number(req.url.slice(i + 1)) || 443;
    if (blocked(host)) {
      stats.refused++;
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    stats.accepted++;
    stats.tunnels++;
    const upstream = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });

  /* Every socket, tunnels included. Chrome keeps an HTTP/2 connection
     through a tunnel open for minutes, and server.close() alone waits for
     all of them: the first version of this run sat for ten minutes in it. */
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        stats,
        rechallenge: () => {
          realm = `hproxy-test-${Date.now()}`;
          forceChallenge = true;
        },
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            for (const s of sockets) s.destroy();
          }),
      });
    });
  });
}

/** A port on 127.0.0.1 that refuses connections: a dead proxy. */
export async function deadPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
