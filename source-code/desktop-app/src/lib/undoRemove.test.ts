import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingRemoves, UNDO_MS, type PendingRemove } from "./undoRemove";

describe("pendingRemoves", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const committed: string[][] = [];
    const heard: (PendingRemove | null)[] = [];
    const r = pendingRemoves(
      (ids) => void committed.push(ids),
      (p) => void heard.push(p),
    );
    return { r, committed, heard };
  };

  it("forgets them only when the time is up", () => {
    const { r, committed, heard } = setup();
    r.remove(["a", "b"], 1000);
    expect(heard[heard.length - 1]).toEqual({ ids: ["a", "b"], at: 1000 });
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(committed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(committed).toEqual([["a", "b"]]);
    expect(heard[heard.length - 1]).toBeNull();
  });

  it("Restore takes them back: nothing is ever forgotten", () => {
    const { r, committed, heard } = setup();
    r.remove(["a"]);
    r.restore();
    expect(heard[heard.length - 1]).toBeNull();
    vi.advanceTimersByTime(UNDO_MS * 3);
    expect(committed).toEqual([]);
  });

  it("a second Remove forgets the first at once and waits for itself", () => {
    const { r, committed } = setup();
    r.remove(["a"]);
    vi.advanceTimersByTime(2000);
    r.remove(["b"]);
    expect(committed).toEqual([["a"]]);
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(committed).toEqual([["a"]]);
    vi.advanceTimersByTime(1);
    expect(committed).toEqual([["a"], ["b"]]);
  });

  it("Restore after a second Remove brings back only the second", () => {
    const { r, committed } = setup();
    r.remove(["a"]);
    r.remove(["b"]);
    r.restore();
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(committed).toEqual([["a"]]);
  });

  it("ignores an empty Remove and counts a proxy once", () => {
    const { r, committed, heard } = setup();
    r.remove([]);
    expect(heard).toEqual([]);
    r.remove(["a", "a"], 5);
    expect(heard[heard.length - 1]).toEqual({ ids: ["a"], at: 5 });
    vi.advanceTimersByTime(UNDO_MS);
    expect(committed).toEqual([["a"]]);
  });

  it("flush settles only when the forgetting is done", async () => {
    const order: string[] = [];
    let finish = () => {};
    const r = pendingRemoves(
      () => new Promise<void>((done) => (finish = () => (order.push("forgotten"), done()))),
      () => {},
    );
    r.remove(["a"]);
    const flushed = r.flush().then(() => order.push("flushed"));
    await Promise.resolve();
    expect(order).toEqual([]);
    finish();
    await flushed;
    expect(order).toEqual(["forgotten", "flushed"]);
  });

  it("flush forgets what waits at once (a timer that fires later does nothing)", () => {
    const { r, committed } = setup();
    r.remove(["a"]);
    r.flush();
    expect(committed).toEqual([["a"]]);
    vi.advanceTimersByTime(UNDO_MS);
    expect(committed).toEqual([["a"]]);
  });
});
