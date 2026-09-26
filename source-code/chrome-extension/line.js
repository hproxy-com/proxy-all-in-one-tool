/* ============================================================
   THE ONE PARSER, IN JAVASCRIPT.

   A line-for-line port of the checking engine's parser (line.rs in
   crates/hproxy-probe of the open-source hproxy-checker app), so a line
   the desktop app and the command-line tool read is a line the
   extension reads, in every shape a provider prints or a person pastes:

     1.2.3.4:8080                          bare
     socks5://1.2.3.4:8080                 scheme kept as a hint
     user:pass@1.2.3.4:8080                URL auth
     1.2.3.4:8080:user:pass                the shape most sellers print
     user:pass:1.2.3.4:8080                login first
     1.2.3.4:8080@user:pass                reverse auth
     1.2.3.4,8080,user,pass                CSV (also pipes, tabs, spaces)
     gateway.vendor.com:8000:user:pass     a hostname
     [2001:db8::1]:8080:user:pass          bracketed IPv6
     2001:db8::1:8080                      unbracketed IPv6
     1.2.3.4;8080;user;pass                semicolons (spreadsheets in Europe)
     "1.2.3.4","8080","user","pass"        quoted CSV
     1.2.3.4:8080 # fast one               a note after the proxy
     IP: 1.2.3.4 Port: 8080                labelled text copied from a page
     socks5 1.2.3.4 1080                   a protocol word, kept as a hint
     [1.2.3.4]:8080                        IPv4 in brackets
     1.2.3.4：8080                          full-width punctuation and digits
     {"ip":"1.2.3.4","port":8080}          a JSON object, read by its keys

   A password containing ":", "@", "/", "?" or "#" survives. Every line in
   engine/hproxy-probe/tests/fixtures/proxy-lines.json is read here exactly
   as the engine reads it (tests/line.test.mjs holds this file to it, and the
   desktop app, which imports this file, is held to it too). Change one,
   change all.
   ============================================================ */

const MAX_LINE_LEN = 512;
/* A provider's JSON export carries a dozen fields beside the four that matter. */
const MAX_JSON_LEN = 4096;
const MAX_HOST_LEN = 253;

/* Not whitespace to a regex's \s in every engine, but they arrive at the
   edges of pasted lines: the byte-order mark Notepad writes and the
   zero-width marks web pages carry. */
const EDGE_JUNK = /^[\s\uFEFF\u200B\u200C\u200D\u2060]+|[\s\uFEFF\u200B\u200C\u200D\u2060]+$/g;

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

export function isIPv4(s) {
  return IPV4.test(s);
}

export function isIPv6(s) {
  if (!s || !s.includes(":") || /[^0-9a-fA-F:.]/.test(s)) return false;
  try {
    // The URL parser is the platform's own IPv6 grammar.
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
}

function isIP(s) {
  return isIPv4(s) || isIPv6(s);
}

/** A token worth dialling as a DNS name: labels of 1 to 63 characters from
    [A-Za-z0-9-], no hyphen at either end, and a last label that is not all
    digits (so `1.2.3.999` is a typo, not a name). Single labels (`squid`,
    `localhost`) are accepted: on a LAN they are real proxies. */
export function isHostname(s) {
  if (!s || s.length > MAX_HOST_LEN) return false;
  const labels = s.split(".");
  for (const l of labels) {
    if (!l || l.length > 63 || l.startsWith("-") || l.endsWith("-") || !/^[A-Za-z0-9-]+$/.test(l)) return false;
  }
  return !/^\d+$/.test(labels[labels.length - 1]);
}

function isDialableHost(s) {
  return isIP(s) || isHostname(s);
}

/** How convincing a token is as the HOST: an address beats a dotted name,
    which beats a single label, which beats nothing. */
function hostStrength(s) {
  if (isIP(s)) return 3;
  if (isHostname(s) && s.includes(".")) return 2;
  if (isHostname(s)) return 1;
  return 0;
}

function portOf(s) {
  if (!/^\d{1,5}$/.test(s)) return null;
  const p = Number(s);
  return p >= 1 && p <= 65535 ? p : null;
}

/** `user:pass`, split at the FIRST colon so a password with colons survives. */
function splitCredentials(s) {
  const i = s.indexOf(":");
  const [user, pass] = i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ""];
  return user || pass ? [user, pass] : null;
}

/** `[v6]:port`, `v6:port` or `host:port`. */
function parseHostPort(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) return null;
    const host = s.slice(1, close);
    // IPv6 is why brackets exist, but `[1.2.3.4]:8080` is pasted too.
    if (!isIP(host)) return null;
    const port = portOf(s.slice(close + 1).replace(/^:+/, ""));
    return port ? { host, port } : null;
  }
  const i = s.lastIndexOf(":");
  if (i < 0) return null;
  const host = s.slice(0, i);
  const port = portOf(s.slice(i + 1));
  return port && isDialableHost(host) ? { host, port } : null;
}

const SCHEMES = [
  ["http://", "http"],
  // A proxy URL's scheme is how you speak TO the proxy, which is plain HTTP
  // even when every site is HTTPS. Writing https:// is a common mix-up.
  ["https://", "http"],
  ["socks5h://", "socks5"],
  ["socks5://", "socks5"],
  ["socks4a://", "socks4"],
  ["socks4://", "socks4"],
];

function stripScheme(s) {
  const lower = s.toLowerCase();
  for (const [prefix, scheme] of SCHEMES) {
    if (lower.startsWith(prefix)) return [scheme, s.slice(prefix.length)];
  }
  const i = s.indexOf("://");
  return i >= 0 ? [null, s.slice(i + 3)] : [null, s];
}

/* The full-width separators and digits (East Asian pages and keyboards) and
   the no-break space, folded to ASCII before anything is read. */
const LOOKALIKES = {
  "\uFF1A": ":",
  "\uFF0C": ",",
  "\uFF1B": ";",
  "\uFF20": "@",
  "\uFF5C": "|",
  "\uFF0E": ".",
  "\uFF0F": "/",
  "\u3000": " ",
  "\u00A0": " ",
};
function foldLookalikes(s) {
  return s
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 48))
    .replace(/[\uFF1A\uFF0C\uFF1B\uFF20\uFF5C\uFF0E\uFF0F\u3000\u00A0]/g, (c) => LOOKALIKES[c]);
}

/* `1.2.3.4:8080 # fast one`: a note after the proxy, cut where a # follows
   whitespace. A # inside a password has no space in front of it and stays. */
function stripTrailingNote(s) {
  const i = s.search(/[ \t]#/);
  return i >= 0 ? s.slice(0, i).trimEnd() : s;
}

/* Quotes around fields, as spreadsheets write CSV. A quote goes only where it
   touches a separator or an end of the line, so an apostrophe inside a
   password stays. */
function unquoteFields(s) {
  if (!/["']/.test(s)) return s;
  const edge = (c) => c === undefined || c === "," || c === ";" || c === "|" || c === "\t" || c === " ";
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && (edge(s[i - 1]) || edge(s[i + 1]))) continue;
    out += c;
  }
  return out;
}

/* Labelled text copied from a page, `IP: 1.2.3.4 Port: 8080 User: bob`. A
   label counts only when a space follows its ":" or "=", so the username in
   `user:pass@1.2.3.4:8080` is never taken for one. Without this, `Port` was
   read as a host name, on port 8080. */
const LABELS = new Set([
  "ip", "host", "hostname", "address", "server", "proxy", "port", "user", "username", "login", "pass", "password",
  "pwd", "type", "protocol", "country",
]);
function dropLabels(s) {
  const words = s.split(" ").filter(Boolean);
  const isLabel = (w) => LABELS.has(w.replace(/[:=]+$/, "").toLowerCase());
  const kept = [];
  let dropped = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if ((w.endsWith(":") || w.endsWith("=")) && isLabel(w) && i + 1 < words.length) {
      dropped = true;
      continue;
    }
    if (isLabel(w) && (words[i + 1] === ":" || words[i + 1] === "=")) {
      dropped = true;
      i++;
      continue;
    }
    kept.push(w);
  }
  return dropped ? kept.join(" ") : s;
}

/* A trailing path, query or fragment, cut only where it follows `host:port`:
   digits after a colon, with an address, a dotted name or a bracketed IPv6 in
   front of them. Cutting at the first "/", "?" or "#" anywhere shortened a
   password such as `pa/ss` to `pa`; and `user:12/34` is a numeric password,
   not a port with a path. */
function stripPath(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "/" && c !== "?" && c !== "#") continue;
    let d = 0;
    while (d < i && s[i - 1 - d] >= "0" && s[i - 1 - d] <= "9") d++;
    if (d < 1 || d > 5 || i <= d || s[i - d - 1] !== ":") continue;
    const before = s.slice(0, i - d - 1);
    const parts = before.split(/[@:,;| \t/]/);
    const host = parts[parts.length - 1];
    if (before.endsWith("]") || isIPv4(host) || (isHostname(host) && host.includes("."))) return s.slice(0, i);
  }
  return s;
}

/* A protocol written as a word of its own: `socks5 1.2.3.4 1080`. */
function schemeWord(s) {
  switch (String(s).trim().toLowerCase()) {
    case "http":
    case "https":
      return "http";
    case "socks5":
    case "socks5h":
    case "socks":
      return "socks5";
    case "socks4":
    case "socks4a":
      return "socks4";
    default:
      return null;
  }
}

/* A JSON object on one line, as several providers export their lists. Read
   by its keys, under the names providers use (case, "_" and "-" ignored), or
   a whole proxy line under `proxy`/`url`. */
function fromJson(s, raw) {
  let o = null;
  try {
    o = JSON.parse(s);
  } catch {
    o = null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: `\`${raw}\` looks like JSON but could not be read` };
  const entries = Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[_-]/g, ""), v]);
  const get = (keys) => {
    for (const [k, v] of entries) {
      if (!keys.includes(k)) continue;
      let found = "";
      if (typeof v === "string") found = v.trim();
      else if (typeof v === "number") found = String(v);
      else if (Array.isArray(v) && typeof v[0] === "string") found = v[0].trim();
      if (found) return found;
    }
    return null;
  };
  const whole = get(["proxy", "url", "line"]);
  if (whole && !whole.startsWith("{")) {
    const p = parseLine(whole);
    if (!p.error) return p;
  }
  const hostRaw = get(["ip", "ipaddress", "host", "hostname", "server", "address", "addr", "proxyaddress", "proxyhost", "proxyip"]);
  const portRaw = get(["port", "proxyport"]);
  const port = portRaw ? portOf(portRaw) : null;
  if (!hostRaw || !port) return { error: `\`${raw}\` is a JSON object without an ip and a port` };
  const host = hostRaw.replace(/^\[+/, "").replace(/\]+$/, "");
  if (!isDialableHost(host)) return { error: `\`${host}\` is not an address or a host name` };
  const user = get(["username", "user", "login", "proxyusername", "proxyuser"]);
  const pass = get(["password", "pass", "pwd", "proxypassword", "proxypass"]);
  return {
    host,
    port,
    username: user ?? "",
    password: user ? (pass ?? "") : "",
    scheme: schemeWord(get(["protocol", "protocols", "type", "scheme"]) ?? ""),
  };
}

/** `s.splitn(n, sep)`: at most `n` parts, the last one keeps the rest. */
function splitn(s, sep, n) {
  const out = [];
  let rest = s;
  while (out.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  out.push(rest);
  return out;
}

/**
 * Read one proxy line.
 * @returns {{host:string, port:number, username:string, password:string, scheme:null|"http"|"socks4"|"socks5"} | {error:string}}
 */
export function parseLine(raw) {
  let s = foldLookalikes(String(raw ?? "")).replace(EDGE_JUNK, "");
  if (!s) return { error: "empty line" };
  if (s.startsWith("#")) return { error: "a comment, not a proxy" };
  if (s.startsWith("{") && s.endsWith("}")) {
    if (s.length > MAX_JSON_LEN) return { error: "the line is too long to be a proxy" };
    return fromJson(s, raw);
  }
  if (s.length > MAX_LINE_LEN) return { error: "the line is too long to be a proxy" };
  s = dropLabels(unquoteFields(stripTrailingNote(s))).replace(EDGE_JUNK, "");
  if (!s) return { error: `\`${raw}\` has no host. A proxy needs a host and a port, like 198.51.100.7:8080.` };

  const [scheme, afterScheme] = stripScheme(s);
  // A trailing path, query or fragment goes before anything counts colons,
  // only where it follows a port, so a password keeps its "/".
  const rest = stripPath(afterScheme).trim();
  if (!rest) return { error: `\`${s}\` has no host. A proxy needs a host and a port, like 198.51.100.7:8080.` };

  const done = (host, port, auth) => ({
    host,
    port,
    username: auth ? auth[0] : "",
    password: auth ? auth[1] : "",
    scheme,
  });

  // `creds@endpoint` and its mirror, split at the LAST @.
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const left = rest.slice(0, at);
    const right = rest.slice(at + 1);
    let hp = parseHostPort(right);
    if (hp) return done(hp.host, hp.port, splitCredentials(left));
    hp = parseHostPort(left);
    if (hp) return done(hp.host, hp.port, splitCredentials(right));
    return { error: `could not find host:port on either side of the @ in \`${s}\`. The shape is username:password@host:port.` };
  }

  // Bracketed IPv6, optionally followed by :user:pass.
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return { error: `unclosed IPv6 bracket in \`${s}\`` };
    const host = rest.slice(1, close);
    // IPv6 is why brackets exist, but `[1.2.3.4]:8080` is pasted too.
    if (!isIP(host)) return { error: `\`${host}\` is not an IP address` };
    const tail = rest.slice(close + 1).split(":").filter(Boolean);
    const port = tail.length ? portOf(tail[0]) : null;
    if (!port) return { error: `no port after the IPv6 address in \`${s}\`` };
    if (tail.length === 1) return done(host, port, null);
    if (tail.length === 3) return done(host, port, [tail[1], tail[2]]);
    return { error: "that looks like the wrong number of fields after the IPv6 address. Use [addr]:port or [addr]:port:username:password." };
  }

  // Unbracketed IPv6: `v6:port`, then `v6:port:user:pass`.
  if ((rest.match(/:/g) || []).length >= 2 && !/[,;|\t ]/.test(rest)) {
    let hp = parseHostPort(rest);
    if (hp && isIPv6(hp.host)) return done(hp.host, hp.port, null);
    const parts = rest.split(":");
    if (parts.length >= 4) {
      hp = parseHostPort(parts.slice(0, -2).join(":"));
      if (hp && isIPv6(hp.host)) return done(hp.host, hp.port, [parts[parts.length - 2], parts[parts.length - 1]]);
    }
  }

  // The colon shape. Four fields read two ways; the stronger host wins, and a
  // tie keeps the seller convention (host first).
  if (!/[,|\t@]/.test(rest)) {
    const parts = splitn(rest, ":", 4);
    if (parts.length === 2) {
      const hp = parseHostPort(rest);
      if (hp) return done(hp.host, hp.port, null);
    } else if (parts.length === 4) {
      const hostFirstPort = portOf(parts[1]);
      const userFirstPort = portOf(parts[3]);
      const a = hostFirstPort ? hostStrength(parts[0]) : 0;
      const b = userFirstPort ? hostStrength(parts[2]) : 0;
      if (a > 0 && a >= b) return done(parts[0], hostFirstPort, [parts[2], parts[3]]);
      if (b > 0) return done(parts[2], userFirstPort, [parts[0], parts[1]]);
    }
  }

  // Everything else: tokenise by every delimiter people paste. Addresses
  // first, then dotted names, then single labels. A semicolon counts only
  // here, after the colon shape had its turn, so a password keeps its ";". A
  // protocol written as a word of its own becomes the scheme hint.
  let wordScheme = null;
  const tokens = rest
    .split(/[:@,;|\t ]/)
    .filter(Boolean)
    .filter((t) => {
      const w = schemeWord(t);
      if (w) {
        wordScheme = wordScheme ?? w;
        return false;
      }
      return true;
    });
  const tokenScheme = scheme ?? wordScheme;
  const accepts = [isIPv4, (t) => isHostname(t) && t.includes("."), isHostname];
  for (const accept of accepts) {
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (!accept(tokens[i])) continue;
      const port = portOf(tokens[i + 1]);
      if (!port) continue;
      const others = tokens.filter((_, j) => j !== i && j !== i + 1);
      // Exactly two leftovers are a login. Anything else is never guessed.
      const login = others.length === 2 ? [others[0], others[1]] : null;
      return { host: tokens[i], port, username: login ? login[0] : "", password: login ? login[1] : "", scheme: tokenScheme };
    }
  }

  if (!rest.includes(":") && !/[,|\t ]/.test(rest)) {
    return { error: `\`${s}\` has no port. A proxy needs a host and a port, like 198.51.100.7:8080.` };
  }
  const i = rest.lastIndexOf(":");
  if (i >= 0) {
    const h = rest.slice(0, i);
    const p = rest.slice(i + 1);
    if (p && !portOf(p) && isDialableHost(h)) return { error: `\`${p}\` is not a port number. It should be something like 8080.` };
  }
  if (rest.split(":").length === 3) {
    return { error: "that looks like three fields. A proxy line is either host:port or host:port:username:password." };
  }
  return { error: `could not read \`${s}\` as a proxy. Try host:port or host:port:username:password.` };
}
