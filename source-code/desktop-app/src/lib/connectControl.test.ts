import { describe, expect, it } from "vitest";
import { sourceOfTarget } from "./connectControl";
import { makeList } from "./saved";

describe("what the relay is asked for", () => {
  const list = makeList("DE", ["a:1:u:p", "b:2"], "every_n", 5, 1);

  it("turns each kind of place into its source", () => {
    expect(sourceOfTarget({ kind: "fixed", line: " a:1:u:p " }, [])).toEqual({ kind: "fixed", line: "a:1:u:p" });
    expect(sourceOfTarget({ kind: "list", id: list.id }, [list])).toEqual({
      kind: "list",
      lines: ["a:1:u:p", "b:2"],
      rotation: { rule: "every_n", n: 5 },
    });
    expect(sourceOfTarget({ kind: "free", country: "", socks5: true }, [])).toEqual({ kind: "free", country: null, socks5: true });
  });

  it("says why when a list is gone or empty", () => {
    expect(sourceOfTarget({ kind: "list", id: "gone" }, [list])).toMatch(/not on this computer/);
    const empty = { ...list, lines: [] };
    expect(sourceOfTarget({ kind: "list", id: list.id }, [empty])).toMatch(/empty/);
  });
});
