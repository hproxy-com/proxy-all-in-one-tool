/* The example proxies the empty fields show: the Checker's box, the paste
   field on My proxies and Connect's field before you have proxies
   (2026-10-12). One line of each
   format people paste, on the documentation addresses (RFC 5737), so no real
   address is ever named. Every one must read as a proxy, or a placeholder
   would teach a format the app refuses (proxyExamples.test.ts). */

export const PROXY_EXAMPLES = [
  "198.51.100.7:8080",
  "198.51.100.7:8080:user:pass",
  "user:pass@203.0.113.24:3128",
  "socks5://192.0.2.44:1080",
] as const;

/** The one a single-line field shows: the format most bought proxies come in. */
export const PROXY_EXAMPLE = PROXY_EXAMPLES[1];

/** The Checker's empty box: what to do, then one line of each format. */
export const PASTE_LIST_HERE = ["Paste your proxies, one per line, in any format:", ...PROXY_EXAMPLES].join("\n");

/** A single-line paste field's placeholder. On a phone the field is about 330 px
    wide, so it shows the example alone (the field's title says what to do). */
export const pasteOneHere = (phone: boolean): string => (phone ? `Like ${PROXY_EXAMPLE}` : `Paste a proxy, like ${PROXY_EXAMPLE}`);
