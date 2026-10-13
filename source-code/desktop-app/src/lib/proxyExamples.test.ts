import { describe, expect, it } from "vitest";
import { readList } from "./checker";
import { PASTE_LIST_HERE, PROXY_EXAMPLE, PROXY_EXAMPLES, pasteOneHere } from "./proxyExamples";

describe("the example proxies in the empty fields", () => {
  it("are each read as a proxy", () => {
    const read = readList(PROXY_EXAMPLES.join("\n"));
    expect(read.rows.map((r) => `${r.host}:${r.port}`)).toEqual(["198.51.100.7:8080", "198.51.100.7:8080", "203.0.113.24:3128", "192.0.2.44:1080"]);
    expect(read.rows.map((r) => r.auth)).toEqual([false, true, true, false]);
  });

  it("name only documentation addresses (RFC 5737)", () => {
    for (const line of PROXY_EXAMPLES) {
      expect(line).toMatch(/(^|[@/])(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}:/);
    }
  });

  it("read the Checker's whole placeholder as the four examples", () => {
    // Pasting the placeholder itself would give the four proxies: its first line is not one.
    expect(readList(PASTE_LIST_HERE).rows).toHaveLength(PROXY_EXAMPLES.length);
  });

  it("show the login format in a single field, shorter on a phone", () => {
    expect(pasteOneHere(false)).toBe(`Paste a proxy, like ${PROXY_EXAMPLE}`);
    expect(pasteOneHere(true).length).toBeLessThanOrEqual(34);
  });
});
