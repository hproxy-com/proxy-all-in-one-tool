import { beforeEach, describe, expect, it } from "vitest";
import {
  applyLook,
  BACKGROUNDS,
  clearPicture,
  CONNECT_LOOKS,
  DEFAULT_BACKGROUND,
  DEFAULT_CONNECT_LOOK,
  DEFAULT_HUB_STYLE,
  HUB_STYLES,
  isBackground,
  isConnectLook,
  isHubStyle,
  loadPicture,
  lookAttributes,
  pictureSize,
  previewConnectLook,
  previewHubStyle,
  savePicture,
} from "./look";
import { COUNTRY_CELLS, GRID, LABELS } from "../components/connect/worldDots";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

/* Vitest runs in node, which has no localStorage and no DOM. Tiny stand-ins. */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

function fakeRoot() {
  const props = new Map<string, string>();
  return {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
    props,
  };
}

describe("the background setting", () => {
  it("defaults to Aura and knows every choice", () => {
    expect(DEFAULT_BACKGROUND).toBe("aura");
    expect(BACKGROUNDS[0][0]).toBe("aura");
    expect(isBackground("contours")).toBe(true);
    expect(isBackground("teal")).toBe(false);
  });

  it("maps each choice to its surface and art", () => {
    expect(lookAttributes("aura")).toEqual({ surface: "aura" });
    expect(lookAttributes("mesh")).toEqual({ surface: "aura", art: "mesh" });
    expect(lookAttributes("paper")).toEqual({ surface: "paper" });
    expect(lookAttributes("white")).toEqual({ surface: "clean" });
    expect(lookAttributes("picture")).toEqual({ surface: "aura", art: "picture" });
  });

  it("sets the attributes, and falls back to Aura when the picture is missing", () => {
    const root = fakeRoot();
    applyLook("ribbon", null, root as unknown as HTMLElement);
    expect(root.dataset).toEqual({ surface: "aura", bg: "ribbon" });
    applyLook("picture", "data:image/jpeg;base64,xyz", root as unknown as HTMLElement);
    expect(root.dataset).toEqual({ surface: "aura", bg: "picture" });
    expect(root.props.get("--bg-picture")).toBe('url("data:image/jpeg;base64,xyz")');
    applyLook("picture", null, root as unknown as HTMLElement);
    expect(root.dataset).toEqual({ surface: "aura" });
    expect(root.props.has("--bg-picture")).toBe(false);
    applyLook("white", null, root as unknown as HTMLElement);
    expect(root.dataset).toEqual({ surface: "clean" });
  });
});

describe("the picture", () => {
  it("keeps the longest side at 1920 and never enlarges", () => {
    expect(pictureSize(4000, 3000)).toEqual({ width: 1920, height: 1440 });
    expect(pictureSize(1200, 2400)).toEqual({ width: 960, height: 1920 });
    expect(pictureSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("is stored on this computer, only as an image, and says when storage refused", () => {
    expect(loadPicture()).toBeNull();
    expect(savePicture("data:image/jpeg;base64,abc")).toBe(true);
    expect(loadPicture()).toBe("data:image/jpeg;base64,abc");
    store.set("hproxy-checker-background-picture", "javascript:alert(1)");
    expect(loadPicture()).toBeNull();
    clearPicture();
    expect(loadPicture()).toBeNull();
    const full = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(savePicture("data:image/jpeg;base64,abc")).toBe(false);
    globalThis.localStorage.setItem = full;
  });
});

/* How a connection that is up looks: five crisp looks, one setting (they
   replaced the soft Halo, Orbit and Aurora). */
describe("connected looks", () => {
  it("has the default first in the list Settings shows", () => {
    expect(CONNECT_LOOKS[0][0]).toBe(DEFAULT_CONNECT_LOOK);
    expect(DEFAULT_SETTINGS.connectLook).toBe(DEFAULT_CONNECT_LOOK);
    expect(CONNECT_LOOKS.map(([l]) => l).sort()).toEqual(["card", "dots", "line", "map", "rings"]);
  });

  it("keeps a picked look and reads an unknown one as the default", () => {
    saveSettings({ ...DEFAULT_SETTINGS, connectLook: "rings" });
    expect(loadSettings().connectLook).toBe("rings");
    store.set("hproxy-checker-settings", JSON.stringify({ connectLook: "halo", look: "d-2026-09-23" }));
    expect(loadSettings().connectLook).toBe(DEFAULT_CONNECT_LOOK);
    expect(isConnectLook("halo")).toBe(false);
  });

  it("shows a look in the browser preview only for a real name", () => {
    expect(previewConnectLook("?demo=connect&look=map")).toBe("map");
    expect(previewConnectLook("?look=aurora")).toBeNull();
    expect(previewConnectLook("")).toBeNull();
  });
});

/* The H in the middle of the route: a button, a switch, or the small sign
   it was before. Its own setting, next to the connected looks. */
describe("the H in the middle", () => {
  it("is a button by default, and the list Settings shows starts with it", () => {
    expect(DEFAULT_HUB_STYLE).toBe("button");
    expect(HUB_STYLES[0][0]).toBe(DEFAULT_HUB_STYLE);
    expect(DEFAULT_SETTINGS.hubStyle).toBe(DEFAULT_HUB_STYLE);
    expect(HUB_STYLES.map(([h]) => h).sort()).toEqual(["button", "small", "switch"]);
  });

  it("keeps a picked style, and settings saved before it existed get the default", () => {
    saveSettings({ ...DEFAULT_SETTINGS, hubStyle: "switch" });
    expect(loadSettings().hubStyle).toBe("switch");
    store.set("hproxy-checker-settings", JSON.stringify({ connectLook: "map", look: "d-2026-09-23" }));
    expect(loadSettings().hubStyle).toBe(DEFAULT_HUB_STYLE);
    store.set("hproxy-checker-settings", JSON.stringify({ hubStyle: "knob", look: "d-2026-09-23" }));
    expect(loadSettings().hubStyle).toBe(DEFAULT_HUB_STYLE);
    expect(isHubStyle("knob")).toBe(false);
  });

  it("shows a style in the browser preview only for a real name", () => {
    expect(previewHubStyle("?demo=connect&hub=switch")).toBe("switch");
    expect(previewHubStyle("?hub=knob")).toBeNull();
    expect(previewHubStyle("")).toBeNull();
  });
});

/* The Map look's dots (made by scripts/world-dots.mjs from Natural Earth). */
describe("the world as dots", () => {
  const cells = (cc: string) => (COUNTRY_CELLS[cc] ?? "").split(",").filter(Boolean).map((c) => parseInt(c, 36));

  it("puts the big proxy countries on the map, inside the grid", () => {
    for (const cc of ["us", "de", "gb", "fr", "br", "in", "jp", "au"]) {
      const list = cells(cc);
      expect(list.length, cc).toBeGreaterThan(0);
      for (const c of list) expect(c).toBeLessThan(GRID.cols * GRID.rows);
    }
  });

  it("finds Germany in Europe and the United States west of it", () => {
    const col = (c: number) => c % GRID.cols;
    const de = cells("de").map(col);
    const us = cells("us").map(col);
    // Germany sits between 6 and 15 degrees east: columns 62 to 65.
    expect(Math.min(...de)).toBeGreaterThanOrEqual(61);
    expect(Math.max(...de)).toBeLessThanOrEqual(65);
    expect(Math.max(...us.filter((c) => c < 60))).toBeLessThan(Math.min(...de));
  });

  // At three degrees a cell, the Netherlands and Belgium fall between cells too.
  it("gives countries too small for a dot a place for the ring", () => {
    for (const cc of ["sg", "hk", "mt", "lu", "bh", "nl", "be"]) {
      expect(cells(cc).length, cc).toBe(0);
      expect(LABELS[cc], cc).toBeDefined();
    }
  });
});
