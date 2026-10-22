import { describe, expect, it } from "vitest";
import type { ProxyView } from "./places";
import { ONE_AT_A_TIME, pasteTitle, pastedWhen, pastesOf, sharedName } from "./pastes";

const proxy = (id: string, addedAt: number, name?: string): ProxyView => ({
  id,
  name,
  address: `${id}:8080`,
  addedAt,
  lastUsedAt: 0,
  uses: 0,
});

/* A paste is the proxies saved in one go, which the library stamps with one added time; each paste
   is its own group (since 2026-10-22). */
describe("every paste is its own group", () => {
  it("reads the pastes from the added time they share, in the list's order", () => {
    const list = [proxy("a", 200), proxy("b", 200), proxy("c", 150), proxy("d", 100), proxy("e", 100), proxy("f", 100)];
    const pastes = pastesOf(list);
    expect(pastes.map((p) => [p.key, p.proxies.map((x) => x.id).join("")])).toEqual([
      ["paste-200", "ab"],
      [ONE_AT_A_TIME, "c"],
      ["paste-100", "def"],
    ]);
  });

  it("puts a paste where its first proxy stands, when the order mixes them", () => {
    const pastes = pastesOf([proxy("x", 300), proxy("a", 100), proxy("y", 300), proxy("b", 100)]);
    expect(pastes.map((p) => p.proxies.map((x) => x.id).join(""))).toEqual(["xy", "ab"]);
  });

  it("keeps proxies added one at a time together, and an unknown time with them", () => {
    const pastes = pastesOf([proxy("a", 10), proxy("b", 20), proxy("c", 0), proxy("d", 0)]);
    expect(pastes).toHaveLength(1);
    expect(pastes[0].key).toBe(ONE_AT_A_TIME);
    expect(pastes[0].proxies).toHaveLength(4);
  });

  it("takes the name the proxies share, its number off", () => {
    expect(sharedName([proxy("a", 1, "Shop 1"), proxy("b", 1, "Shop 2"), proxy("c", 1, "Shop 12")])).toBe("Shop");
    expect(sharedName([proxy("a", 1, "Shop 1"), proxy("b", 1, "Bank 2")])).toBe("");
    expect(sharedName([proxy("a", 1), proxy("b", 1)])).toBe("");
  });

  it("says when a paste came in", () => {
    const now = new Date(2026, 9, 22, 15, 0).getTime();
    expect(pastedWhen(new Date(2026, 9, 22, 14, 5).getTime(), now)).toBe("today at 14:05");
    expect(pastedWhen(new Date(2026, 9, 21, 9, 12).getTime(), now)).toBe("yesterday at 09:12");
    expect(pastedWhen(new Date(2026, 9, 19, 3, 12).getTime(), now)).toBe("19 Oct at 03:12");
    expect(pastedWhen(new Date(2025, 9, 19, 3, 12).getTime(), now)).toBe("19 Oct 2025 at 03:12");
    const paste = pastesOf([proxy("a", new Date(2026, 9, 22, 14, 5).getTime()), proxy("b", new Date(2026, 9, 22, 14, 5).getTime())])[0];
    expect(pasteTitle(paste, now)).toBe("Pasted today at 14:05");
  });
});
