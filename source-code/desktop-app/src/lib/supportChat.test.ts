import { describe, expect, it } from "vitest";
import { START, msgOf, onChatEvent, supportWords, type ChatState } from "./supportChat";

const sending = (s: ChatState, id: string, body: string): ChatState => ({
  ...s,
  messages: [...s.messages, { id, mine: true, body, at: 1, sent: "sending" }],
});

describe("msgOf", () => {
  it("reads the chat's message, never a note between support's people", () => {
    expect(msgOf({ id: "m1", body: "hello", author_type: "agent", author_name: "Sam", created_at: "2026-10-11T18:42:55Z" })).toMatchObject({
      id: "m1",
      mine: false,
      by: "Sam",
      sent: "delivered",
      at: Date.parse("2026-10-11T18:42:55Z"),
    });
    expect(msgOf({ id: "m2", body: "secret", is_internal: true })).toBeNull();
    expect(msgOf({ id: "m3", body: "  " })).toBeNull();
    expect(msgOf({ id: "m4", body: "mine", author_type: "visitor", read_by_agent_at: "2026-10-11T18:43:00Z" })?.sent).toBe("read");
  });
});

describe("onChatEvent", () => {
  it("opens with the token, the thread and support's own words", () => {
    const s = onChatEvent(START, { kind: "ready", token: "vt_1", conversation: "c1", online: true, replyTime: "1-3 minutes" }, true);
    expect(s).toMatchObject({ link: "open", token: "vt_1", conversation: "c1", online: true });
    expect(s.intro?.replyTime).toBe("1-3 minutes");
  });

  it("takes a sent message from Sending to Delivered to Read under the server's id", () => {
    let s = sending(START, "app-1", "hi");
    s = onChatEvent(s, { kind: "ack", ack: { id: "app-1", state: "delivered", server_id: "m9", conversation_id: "c2" } }, true);
    expect(s.messages[0]).toMatchObject({ id: "m9", sent: "delivered" });
    expect(s.conversation).toBe("c2");
    s = onChatEvent(s, { kind: "ack", ack: { id: "app-1", state: "read", server_id: "m9" } }, true);
    expect(s.messages[0].sent).toBe("read");
  });

  it("keeps a message on its way after the thread the chat sends back", () => {
    let s = sending(START, "app-2", "still going");
    s = onChatEvent(s, { kind: "history", messages: [{ id: "m1", body: "earlier", author_type: "visitor" }] }, true);
    expect(s.messages.map((m) => m.body)).toEqual(["earlier", "still going"]);
  });

  it("counts an answer as unseen only while Help is not showing, and stops the typing", () => {
    const typing = { ...START, typing: true };
    const away = onChatEvent(typing, { kind: "message", message: { id: "m5", body: "answer", author_type: "agent" } }, false);
    expect(away).toMatchObject({ unseen: 1, typing: false });
    const here = onChatEvent(START, { kind: "message", message: { id: "m5", body: "answer", author_type: "agent" } }, true);
    expect(here.unseen).toBe(0);
    expect(onChatEvent(away, { kind: "message", message: { id: "m5", body: "answer", author_type: "agent" } }, false).messages).toHaveLength(1);
  });

  it("marks a refused message failed, and a lost socket as down", () => {
    let s = sending({ ...START, link: "open" }, "app-3", "x");
    s = onChatEvent(s, { kind: "error", id: "app-3" }, true);
    expect(s.messages[0].sent).toBe("failed");
    expect(onChatEvent(s, { kind: "down" }, true).link).toBe("down");
    expect(onChatEvent(START, { kind: "down" }, true).link).toBe("closed");
  });
});

describe("supportWords", () => {
  it("says whether someone is there, else how soon they answer", () => {
    expect(supportWords({ link: "opening", online: false, intro: null })).toBe("connecting");
    expect(supportWords({ link: "down", online: false, intro: null })).toBe("reconnecting");
    expect(supportWords({ link: "open", online: true, intro: null })).toBe("online now");
    expect(supportWords({ link: "open", online: false, intro: { replyTime: "1-3 minutes" } })).toBe("usually answers in 1-3 minutes");
    expect(supportWords({ link: "open", online: false, intro: { replyTime: "within a day" } })).toBe("usually answers within a day");
    expect(supportWords({ link: "open", online: false, intro: {} })).toBe("usually answers within a few hours");
  });
});
