/* ============================================================
   failure.js: why a proxy failed, by its name, in the words every
   app of ours uses (proxy-engine/hproxy-connection/src/verify.rs):
   the error, a colon, what it means. The popup shows the name large
   and the rest under it.

   Read from what Chrome reports about a request (the net::ERR_ codes
   of webRequest.onErrorOccurred) and from a probe's own time limit.

   A plain script that sets one global, not a module: the worker is a
   classic one and cannot import (the popup loads it too).
   ============================================================ */

(() => {
  const TIMED_OUT = "Timed out: the proxy did not answer";

  const WORDS = [
    [/ERR_(CONNECTION_)?TIMED_OUT/, TIMED_OUT],
    [/ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_REFUSED/, "Connection refused: nothing answers at that address"],
    [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/, "Address not found: that name does not exist"],
    [/ERR_PROXY_AUTH|ERR_TOO_MANY_RETRIES/, "Login refused: check the username and password"],
    [/ERR_SOCKS_CONNECTION_HOST_UNREACHABLE/, "Proxy error: host unreachable"],
    [/ERR_SOCKS_CONNECTION_FAILED/, "Proxy error: the SOCKS connection failed"],
    [/ERR_TUNNEL_CONNECTION_FAILED/, "Proxy error: it did not open the page"],
    [/ERR_CERT_|ERR_SSL_/, "Bad certificate: the proxy showed a false one"],
    [/ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED/, "Connection closed: the proxy hung up"],
    [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_ACCESS_DENIED/, "No internet: this computer is offline"],
  ];

  /** The words for what Chrome said, or null when it said nothing we can name. */
  const ofChrome = (code) => WORDS.find(([match]) => match.test(String(code || "")))?.[1] ?? null;

  /** The words for a page that came back with an error of its own. */
  const ofStatus = (status) => `Error ${status}: the page answered with an error`;

  /** The error by its name, and what it means. Words without a name stay whole. */
  function parts(words) {
    const said = String(words || "");
    const at = said.indexOf(": ");
    return at < 0 ? { name: "", detail: said } : { name: said.slice(0, at), detail: said.charAt(at + 2).toUpperCase() + said.slice(at + 3) };
  }

  globalThis.HPROXY_FAILURE = { TIMED_OUT, ofChrome, ofStatus, parts };
})();
