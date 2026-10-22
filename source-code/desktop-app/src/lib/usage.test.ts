import { describe, expect, it } from "vitest";
import { USAGE_HOLDS, USAGE_NEVER, usageAnswer, usageGet } from "./usage";

describe("usage counts in the browser preview", () => {
  it("starts on a yes with a sample report, and a no forgets the report", async () => {
    const first = await usageGet();
    expect(first.answer).toBe("yes");
    expect(first.last?.app).toBe("desktop");
    expect(await usageAnswer(false)).toEqual({ answer: "no", last: null });
    expect((await usageAnswer(true)).answer).toBe("yes");
  });

  it("says what a report holds in plain lines, with no dash", () => {
    expect(USAGE_HOLDS.length).toBe(6);
    for (const line of [...USAGE_HOLDS, USAGE_NEVER]) expect(line).not.toMatch(/[–—]| - /);
  });
});
