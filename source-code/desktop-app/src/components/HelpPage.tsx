import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { HELLO, STARTERS, supportChat, supportWords, type Msg } from "../lib/supportChat";
import HLetter from "./HLetter";
import { Icon, cx } from "./ui";

/* Help: talking to HProxy support, right here (2026-10-18, as the phone app's Help tab since
   2026-10-11; the paste lab's round 12 drew it for the computer). The chat of chat.hproxy.com,
   the same people who answer on the website; the app holds the socket (src-tauri/src/support.rs)
   and lib/supportChat.ts keeps the thread. Support sees which app wrote, where it came from and
   its version, nothing else. It says "HProxy support" and nothing else about who runs it.

   The chat opens the first time Help shows and stays open while the app runs, so an answer that
   comes while you are on another page puts a dot on Help's tab (TitleBar.tsx). Enter sends,
   Shift+Enter starts a new line. */

const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function HelpPage({ active }: { active: boolean }) {
  const chat = useSyncExternalStore(supportChat.subscribe, supportChat.snapshot);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void supportChat.show(active);
  }, [active]);

  // The newest at the bottom, in sight; what support wrote is read once it shows.
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (active && chat.messages.some((m) => !m.mine)) supportChat.read();
  }, [chat.messages.length, chat.typing, active]);

  // The box grows with what is written, up to five lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const send = () => {
    if (supportChat.send(draft)) setDraft("");
    box.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const start = (words: string) => {
    setDraft(words);
    setTimeout(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(words.length, words.length);
    }, 0);
  };
  const hello = chat.intro?.welcome || chat.intro?.greeting || HELLO;

  return (
    <div className="ux-help">
      <div className="ux-help-head">
        <h1>Help</h1>
        <p className="ux-help-who">
          <HLetter className="h-4 w-4" gid="help-h" />
          {/* Always these words: never a person's name, never who runs the chat. */}
          HProxy support · {supportWords(chat)}
        </p>
      </div>
      <div ref={list} className="ux-help-thread" aria-live="polite">
        <Bubble m={{ id: "hello", mine: false, body: hello, at: 0, sent: "delivered" }} hideTime />
        {chat.messages.map((m) => (
          <Bubble key={m.id} m={m} onRetry={() => supportChat.retry(m)} />
        ))}
        {chat.typing && <p className="ux-help-typing">Support is typing</p>}
      </div>
      <div className="ux-help-starters">
        {STARTERS.map(([word, words]) => (
          <button key={word} type="button" className="ux-help-starter" onClick={() => start(words)}>
            {word}
          </button>
        ))}
      </div>
      <div className="ux-help-bar">
        <textarea
          ref={box}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="Write a message"
          aria-label="Write a message to HProxy support"
          className="ux-help-box"
        />
        <button type="button" className={cx("ux-help-send", draft.trim() && "is-ready")} onClick={send} aria-label="Send" title="Send (Enter)">
          <Icon.send />
        </button>
      </div>
    </div>
  );
}

/** One message: yours on the right in our blue, support's on the left. The foot says when, and
    for yours whether it went: Sending, Read, or "Not sent · click to send again". */
function Bubble({ m, hideTime = false, onRetry }: { m: Msg; hideTime?: boolean; onRetry?: () => void }) {
  const foot =
    m.sent === "sending"
      ? "Sending"
      : m.sent === "failed"
        ? "Not sent · click to send again"
        : hideTime
          ? null
          : m.sent === "read"
            ? `${hhmm(m.at)} · Read`
            : hhmm(m.at);
  const body = (
    <>
      {m.by && !m.mine && <span className="ux-bubble-by">{m.by}</span>}
      <span className="ux-bubble-text">{m.body}</span>
      {foot && <span className="ux-bubble-foot">{foot}</span>}
    </>
  );
  return (
    <div className={cx("ux-bubble-row", m.mine && "is-mine")}>
      {m.sent === "failed" ? (
        <button type="button" className="ux-bubble is-mine is-failed" onClick={onRetry}>
          {body}
        </button>
      ) : (
        <div className={cx("ux-bubble", m.mine && "is-mine")}>{body}</div>
      )}
    </div>
  );
}
