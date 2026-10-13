import { afterEach, describe, expect, it, vi } from "vitest";
import { closeNewest, goBack, openCount, pushBack, setPageBack } from "./back";
import { hexOf, PHONE_TABS, phoneTab, tabMove } from "./phone";

describe("the phone's tabs", () => {
  it("puts the checker on a tab of its own, the places on Proxies", () => {
    expect(phoneTab("checker")).toBe("checker");
    expect(phoneTab("proxies")).toBe("proxies");
    expect(phoneTab("connect")).toBe("connect");
    expect(phoneTab("settings")).toBe("settings");
  });

  /* Use with AI is a computer's page; a phone never shows it, and if it ever
     came up it would read as Connect rather than as nothing. */
  it("shows a computer-only page as Connect", () => {
    expect(phoneTab("ai")).toBe("connect");
  });

  it("slides toward the side of the tab", () => {
    expect(PHONE_TABS).toEqual(["connect", "proxies", "checker", "settings"]);
    expect(tabMove("connect", "settings")).toBe("next");
    expect(tabMove("checker", "proxies")).toBe("prev");
    expect(tabMove("settings", "connect")).toBe("prev");
  });
});

describe("the page's colour for the phone", () => {
  it("reads the colour the browser computes", () => {
    expect(hexOf("rgb(12, 12, 15)")).toBe("#0c0c0f");
    expect(hexOf("rgb(240 241 244)")).toBe("#f0f1f4");
    expect(hexOf("rgba(255, 255, 255, 1)")).toBe("#ffffff");
  });

  it("gives nothing for a see-through or unreadable colour", () => {
    expect(hexOf("rgba(0, 0, 0, 0)")).toBe("");
    expect(hexOf("rgba(12, 12, 15, 0.5)")).toBe("");
    expect(hexOf("transparent")).toBe("");
    expect(hexOf("")).toBe("");
  });
});

describe("Back", () => {
  afterEach(() => {
    while (closeNewest()) {
      /* empty the stack between tests */
    }
  });

  it("closes the newest thing open first", () => {
    const closed: string[] = [];
    pushBack(() => closed.push("settings section"));
    pushBack(() => closed.push("menu"));
    goBack();
    expect(closed).toEqual(["menu"]);
    goBack();
    expect(closed).toEqual(["menu", "settings section"]);
    expect(openCount()).toBe(0);
  });

  it("hands Back to the page when nothing is open", () => {
    const page = vi.fn();
    const undo = setPageBack(page);
    goBack();
    expect(page).toHaveBeenCalledTimes(1);
    undo();
  });

  it("forgets a thing that closed by itself", () => {
    const page = vi.fn();
    const undo = setPageBack(page);
    const menu = vi.fn();
    const closedByTap = pushBack(menu);
    closedByTap();
    goBack();
    expect(menu).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalledTimes(1);
    undo();
  });
});
