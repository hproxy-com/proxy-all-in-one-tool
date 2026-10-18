/* Help's support chat, for the window (2026-10-18; the phone app's SupportChat.kt, the same
   rules): the app holds the socket (src-tauri/src/support.rs) and tells what happens as "chat"
   events; this keeps the thread for the screen. A message shows at once, "Sending" until the chat
   has it; one that did not go says so and goes again on a press. The chat shows "HProxy support"
   and its people, nothing else: no company, no address.

   The reducer is plain, so it can be tested without a window; the store at the end wires it to
   the app (no React in here: HelpPage.tsx reads it with useSyncExternalStore). */

import { chatClose, chatOpen, chatRead, chatSend, onChat, type ChatEvent } from "./tauri";

export type Sent = "sending" | "delivered" | "read" | "failed";

export type Msg = {
  /** The server's id, or (until it answered) the window's own. */
  id: string;
  mine: boolean;
  body: string;
  /** Milliseconds since 1970. */
  at: number;
  sent: Sent;
  /** Who answered, when the chat names a person. */
  by?: string;
};

export type Intro = { name?: string; greeting?: string; welcome?: string; replyTime?: string };

export type Link = "closed" | "opening" | "open" | "down";

export type ChatState = {
  messages: Msg[];
  link: Link;
  /** Someone from support is there now. */
  online: boolean;
  typing: boolean;
  intro: Intro | null;
  conversation: string | null;
  token: string | null;
  /** Answers from support that came while Help was not showing. */
  unseen: number;
};

export const START: ChatState = { messages: [], link: "closed", online: false, typing: false, intro: null, conversation: null, token: null, unseen: 0 };

/** The words the chat starts with when it has none of its own. */
export const HELLO =
  "Hi! This is HProxy support. Ask us anything about your proxies, the app or an order, or tell us an idea: we answer right here.";

/** The three ways people start: an idea, a problem, a country. */
export const STARTERS: readonly (readonly [string, string])[] = [
  ["I have an idea", "Idea: "],
  ["Something broke", "Something broke: "],
  ["I need a country", "A country I need: "],
];

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);

/** "2026-10-11T18:42:55.399470Z" to milliseconds. */
function timeOf(s: unknown): number {
  const t = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/** A message as the chat sends it; nothing for an empty one or a note between support's people. */
export function msgOf(raw: unknown): Msg | null {
  const o = obj(raw);
  const body = str(o?.body);
  if (!o || !body || o.is_internal === true) return null;
  const mine = o.author_type === "visitor";
  return {
    id: String(o.id ?? ""),
    mine,
    body,
    at: timeOf(o.created_at),
    sent: mine && o.read_by_agent_at ? "read" : "delivered",
    by: mine ? undefined : str(o.author_name),
  };
}

const mark = (s: ChatState, id: string, f: (m: Msg) => Msg): ChatState => ({ ...s, messages: s.messages.map((m) => (m.id === id ? f(m) : m)) });

/** One "chat" event; `showing`: Help is on screen (an answer then counts as seen). */
export function onChatEvent(s: ChatState, e: ChatEvent, showing: boolean): ChatState {
  switch (e.kind) {
    case "ready":
      return {
        ...s,
        link: "open",
        token: str(e.token) ?? s.token,
        conversation: str(e.conversation) ?? null,
        online: e.online === true,
        intro: { name: str(e.name), greeting: str(e.greeting), welcome: str(e.welcome), replyTime: str(e.replyTime) },
      };
    case "history": {
      const old = (Array.isArray(e.messages) ? e.messages : []).map(msgOf).filter((m): m is Msg => !!m);
      // Messages still on their way stay after the thread as the chat keeps it.
      const pending = s.messages.filter((m) => (m.sent === "sending" || m.sent === "failed") && !old.some((o) => o.mine && o.body === m.body));
      return { ...s, messages: [...old, ...pending] };
    }
    case "message": {
      const m = msgOf(e.message);
      if (!m) return s;
      const conversation = str(obj(e.message)?.conversation_id) ?? s.conversation;
      if (s.messages.some((x) => x.id === m.id)) return { ...s, conversation };
      return {
        ...s,
        conversation,
        messages: [...s.messages, m],
        typing: m.mine ? s.typing : false,
        unseen: !m.mine && !showing ? s.unseen + 1 : s.unseen,
      };
    }
    case "ack": {
      const a = obj(e.ack);
      if (!a) return s;
      const id = String(a.id ?? "");
      const server = str(a.server_id);
      const next = { ...s, conversation: str(a.conversation_id) ?? s.conversation };
      if (a.state === "delivered") return mark(next, id, (m) => ({ ...m, id: server ?? m.id, sent: "delivered" }));
      if (a.state === "read") return mark(next, server ?? id, (m) => ({ ...m, sent: "read" }));
      return next;
    }
    case "conversation":
      return { ...s, conversation: str(obj(e.conversation)?.id) ?? s.conversation };
    case "typing":
      return { ...s, typing: e.on === true };
    case "online":
      return { ...s, online: e.online === true };
    case "deleted":
      return { ...s, messages: s.messages.filter((m) => m.id !== String(e.id ?? "")) };
    case "down":
      return { ...s, link: s.link === "closed" ? "closed" : "down", typing: false };
    case "error": {
      const id = String(e.id ?? "");
      return id.startsWith("app-") ? mark(s, id, (m) => ({ ...m, sent: "failed" })) : s;
    }
    default:
      return s;
  }
}

/** Under "HProxy support": whether someone is there, else how soon they usually answer. Never a
    person's name, never who runs the chat. */
export function supportWords(s: Pick<ChatState, "link" | "online" | "intro">): string {
  if (s.link === "down") return "reconnecting";
  if (s.link !== "open") return "connecting";
  if (s.online) return "online now";
  const t = s.intro?.replyTime?.trim();
  if (!t) return "usually answers within a few hours";
  // "1-3 minutes" reads "usually answers in 1-3 minutes"; "within a day" as it is.
  return /^\d/.test(t) || t.startsWith("a ") ? `usually answers in ${t}` : `usually answers ${t}`;
}

/* ── The store ──────────────────────────────────────────────────────────── */

const TOKEN_KEY = "hproxy-chat-token";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function keepToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* without the token the next start is a new thread; nothing breaks */
  }
}

function createSupportChat() {
  let state: ChatState = START;
  let showing = false;
  let counter = 0;
  let listening: Promise<() => void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: ChatState) => {
    if (next.token && next.token !== state.token) keepToken(next.token);
    state = next;
    for (const fn of listeners) fn();
  };
  const listen = () => {
    listening ??= onChat((e) => set(onChatEvent(state, e, showing)));
    return listening;
  };

  const store = {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    snapshot(): ChatState {
      return state;
    },

    /** Help shows: the chat opens (once), and what came meanwhile counts as seen. */
    async show(on: boolean): Promise<void> {
      showing = on;
      if (!on) return;
      if (state.unseen) set({ ...state, unseen: 0 });
      if (state.link === "open" || state.link === "opening") return;
      set({ ...state, link: "opening" });
      await listen();
      try {
        await chatOpen(state.token ?? readToken());
      } catch {
        set({ ...state, link: "down" });
      }
    },

    /** Send the words; they show at once, "Sending" until the chat has them. */
    send(text: string): boolean {
      const body = text.trim();
      if (!body) return false;
      const id = `app-${Date.now()}-${counter++}`;
      set({ ...state, messages: [...state.messages, { id, mine: true, body, at: Date.now(), sent: "sending" }] });
      void chatSend(id, body).catch(() => {
        set(mark(state, id, (m) => ({ ...m, sent: "failed" })));
        if (state.link !== "opening") void store.show(showing);
      });
      return true;
    },

    /** Send a message again that did not go. */
    retry(m: Msg): void {
      set({ ...state, messages: state.messages.filter((x) => x.id !== m.id) });
      store.send(m.body);
    },

    /** The person read the thread: support sees it. */
    read(): void {
      if (state.conversation) void chatRead(state.conversation).catch(() => {});
    },

    /** The app is going away: the socket closes. */
    close(): void {
      void chatClose();
      set({ ...state, link: "closed" });
    },
  };
  return store;
}

/** Help's chat, for the window. */
export const supportChat = createSupportChat();
