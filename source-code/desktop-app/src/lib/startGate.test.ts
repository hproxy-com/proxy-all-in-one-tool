import { describe, expect, it } from "vitest";
import { previewGate, share, sizeLine, startPlan } from "./startGate";

/* What the start does for each kind of copy, and what its screen says while it downloads. The
   look itself runs against the Rust side (src-tauri/src/update.rs, store.rs), which has its own
   tests for the rules: newer and signed after release, no install loop, no lock-out. */

describe("startPlan", () => {
  it("installs first where the copy updates itself", () => {
    expect(startPlan("windows")).toBe("install");
    expect(startPlan("macos")).toBe("install");
    expect(startPlan("linux-appimage")).toBe("install");
  });

  it("hands the Microsoft Store copy to the Store", () => {
    expect(startPlan("microsoft-store")).toBe("store");
  });

  it("tells a package's owner, because nothing may install a package for them", () => {
    expect(startPlan("apk")).toBe("tell");
    expect(startPlan("linux-deb")).toBe("tell");
    expect(startPlan("linux-rpm")).toBe("tell");
  });

  it("does nothing where the store runs its own update, or nothing is known", () => {
    expect(startPlan("google-play")).toBe("nothing");
    expect(startPlan("app-store")).toBe("nothing");
    expect(startPlan(null)).toBe("nothing");
  });
});

describe("the download's bar", () => {
  it("fills by the share downloaded, and stays full, never past it", () => {
    expect(share({ downloaded: 1_100_000, total: 4_400_000 })).toBe(0.25);
    expect(share({ downloaded: 5_000_000, total: 4_400_000 })).toBe(1);
  });

  it("runs without a share while the size is unknown", () => {
    expect(share(null)).toBeNull();
    expect(share({ downloaded: 1_000, total: null })).toBeNull();
    expect(share({ downloaded: 1_000, total: 0 })).toBeNull();
  });

  it("says the size in megabytes", () => {
    expect(sizeLine({ downloaded: 3_250_000, total: 4_613_734 })).toBe("3.1 of 4.4 MB");
    expect(sizeLine({ downloaded: 3_250_000, total: null })).toBe("3.1 MB");
    expect(sizeLine(null)).toBeNull();
  });
});

describe("previewGate", () => {
  it("shows each screen by name in the browser preview, and nothing without one", () => {
    expect(previewGate("?gate=downloading")?.stage).toBe("downloading");
    expect(previewGate("?gate=store")?.stage).toBe("store");
    const required = previewGate("?gate=required");
    expect(required?.stage === "new-version" && required.verdict.required).toBe(true);
    expect(previewGate("")).toBeNull();
    expect(previewGate("?demo=1")).toBeNull();
  });
});
