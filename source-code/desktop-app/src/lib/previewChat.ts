/* BROWSER PREVIEW ONLY. A stand-in for the support chat, so Help can be looked at (and
   screenshotted) without the app: it opens, takes a message and marks it delivered. Nobody
   answers here: a made-up reply would read like support's words. The app speaks to the real
   chat (src-tauri/src/support.rs). Nothing in here may be imported by production code paths. */

import type { ChatEvent } from "./tauri";

const listeners = new Set<(e: ChatEvent) => void>();
const tell = (e: ChatEvent) => {
  for (const cb of listeners) cb(e);
};

export function onDemoChat(cb: (e: ChatEvent) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

let open = false;

export function demoChatOpen(): void {
  if (open) return;
  open = true;
  setTimeout(() => tell({ kind: "ready", token: "preview", conversation: null, online: false, replyTime: null }), 400);
}

export function demoChatSend(id: string, body: string): void {
  if (!open) throw new Error("the chat is not open");
  if (!body.trim()) throw new Error("write something first");
  setTimeout(() => tell({ kind: "ack", ack: { id, state: "delivered", server_id: `preview-${id}` } }), 350);
}

export function demoChatClose(): void {
  open = false;
}
