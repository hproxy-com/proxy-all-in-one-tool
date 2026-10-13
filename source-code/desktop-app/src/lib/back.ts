/* Back, for the whole app: Android's Back button and Back gesture.

   Whatever opens on top of a page (a menu, a sheet, a tip, a step deeper
   into Settings) says how to close it while it is open, with `useBack`;
   Back closes the newest of them first. With nothing open, the page shell
   decides (`setPageBack`): a page other than Connect goes back to Connect,
   and on Connect the app goes to the background, the way Home does.

   Back never ends the app. Android's own default would (the Activity
   finishes and the process with it), and a proxy connection must outlive a
   Back press, the way a VPN outlives one. */

import { useEffect, useRef } from "react";
import { isMobile, isTauri, phoneToBackground } from "./tauri";

type Step = { close: () => void };

/** What is open on top of the page, oldest first. */
const open: Step[] = [];
/** The page shell's own Back, when nothing is open. */
let pageBack: (() => void) | null = null;

/** Close the newest thing open. False when nothing was open. */
export function closeNewest(): boolean {
  const step = open.pop();
  if (!step) return false;
  step.close();
  return true;
}

/** One press of Back: the newest thing open, else the page shell, else the
    app goes to the background. */
export function goBack(): void {
  if (closeNewest()) return;
  if (pageBack) pageBack();
  else void phoneToBackground().catch(() => {});
}

/** The page shell's Back (PhoneShell.tsx). Returns the undo. */
export function setPageBack(fn: () => void): () => void {
  pageBack = fn;
  return () => {
    if (pageBack === fn) pageBack = null;
  };
}

/** How many things are open: for tests. */
export function openCount(): number {
  return open.length;
}

/** Register `close` while `isOpen`: Back calls it, newest first. The latest
    `close` is called, so it may read state from the render it came from. */
export function useBack(isOpen: boolean, close: () => void): void {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!isOpen) return;
    const step: Step = { close: () => latest.current() };
    open.push(step);
    return () => {
      const i = open.indexOf(step);
      if (i >= 0) open.splice(i, 1);
    };
  }, [isOpen]);
}

/** The same, outside React (tests, plain code). Returns the undo. */
export function pushBack(close: () => void): () => void {
  const step: Step = { close };
  open.push(step);
  return () => {
    const i = open.indexOf(step);
    if (i >= 0) open.splice(i, 1);
  };
}

let listening = false;

/** Take Back over from Android, once, for the app's lifetime. Nothing
    happens in a browser or on a computer. */
export function listenForBack(): void {
  if (listening || !isTauri() || !isMobile()) return;
  listening = true;
  void import("@tauri-apps/api/app")
    .then(({ onBackButtonPress }) => onBackButtonPress(() => goBack()))
    .catch(() => {
      // Without the listener Android keeps its own Back.
      listening = false;
    });
}
