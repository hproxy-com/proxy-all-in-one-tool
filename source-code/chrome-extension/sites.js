/* ============================================================
   sites.js: which sites use the proxy, the rule the other apps
   keep in proxy-engine/hproxy-relay/src/routes.rs, for Chrome: all
   of them, all except the ones named, or only those. Chrome decides
   each request itself, so the rule becomes its bypass list, or a
   small script for "only these".

   A plain script that sets one global, not a module: the worker is
   a classic one and cannot import (the popup loads it too).
   ============================================================ */

(() => {
  const IP = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

  /** One site from what a person wrote: a name, an address, a range, or a pasted link. */
  function siteOf(word) {
    const w = word.trim().toLowerCase();
    if (IP.test(w)) return w;
    let name = w.includes("://") ? w.slice(w.indexOf("://") + 3) : w;
    name = name.split(/[/?#]/)[0];
    name = name.slice(name.lastIndexOf("@") + 1).split(":")[0];
    name = name.replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
    const fits = name.includes(".") && name.split(".").every((part) => /^[a-z0-9-]+$/.test(part));
    return fits ? name : null;
  }

  /** What a person wrote, as sites; the words that are none come back apart. */
  function read(text) {
    const sites = [];
    const wrong = [];
    for (const word of String(text || "").split(/[\s,;]+/)) {
      if (!word) continue;
      const site = siteOf(word);
      if (site === null) wrong.push(word);
      else if (!sites.includes(site)) sites.push(site);
    }
    return { sites, wrong };
  }

  /** Whether `site` covers `host`: the name itself, or anything under it. */
  const covers = (site, host) => host === site || host.endsWith(`.${site}`);

  /** The sites as Chrome's bypass list: a name, and everything under it. */
  function bypassRules(sites) {
    return sites.flatMap((site) => (IP.test(site) ? [site] : [site, `*.${site}`]));
  }

  /** The script for "only these": the sites through `way`, the rest straight out. `through` is
      what goes through the proxy whatever the list says: where the connection's own test goes. */
  function onlyScript(mark, way, sites, through) {
    const names = sites.filter((site) => !IP.test(site));
    const addresses = sites.filter((site) => IP.test(site));
    return [
      `// ${mark}`,
      "function FindProxyForURL(url, host) {",
      `  var way = ${JSON.stringify(way)};`,
      `  if (host === ${JSON.stringify(through)}) return way;`,
      `  var names = ${JSON.stringify(names)};`,
      '  for (var i = 0; i < names.length; i++) if (host === names[i] || dnsDomainIs(host, "." + names[i])) return way;',
      `  var addresses = ${JSON.stringify(addresses)};`,
      "  for (var j = 0; j < addresses.length; j++) {",
      '    var parts = addresses[j].split("/");',
      '    var bits = parts.length > 1 ? Number(parts[1]) : 32;',
      '    var mask = bits === 0 ? "0.0.0.0" : [24, 16, 8, 0].map(function (s) { return ((0xffffffff << (32 - bits)) >>> s) & 255; }).join(".");',
      '    if (/^[0-9.]+$/.test(host) && isInNet(host, parts[0], mask)) return way;',
      "  }",
      '  return "DIRECT";',
      "}",
    ].join("\n");
  }

  globalThis.HPROXY_SITES = { read, covers, bypassRules, onlyScript };
})();
