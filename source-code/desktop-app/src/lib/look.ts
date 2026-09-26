/* The app's background: a setting, so people can make the app their own.

   Aura is the default: the warm paper page with a light in the corners, the
   dot grid and frosted cards. The others are the studies made the same
   night, plus plain paper, plain white, and
   a picture of the person's own. The picture is scaled down and kept on this
   computer only, beside the settings, never sent anywhere.

   How it reaches the screen: two attributes on <html> that globals.css reads,
   `data-surface` (the cards and greys: aura, paper or clean) and `data-bg`
   (which background Aura wears), and for a picture the CSS variable
   `--bg-picture`. `applyLook` sets them; main.tsx calls it before the first
   frame so the app never flashes the old look. */

import { thisDevice } from "./tauri";

export type Background = "aura" | "glow" | "mesh" | "grain" | "contours" | "watermark" | "ribbon" | "paper" | "white" | "picture";

/** In the order the picker shows them, the default first. */
export const BACKGROUNDS: readonly (readonly [Background, string])[] = [
  ["aura", "Aura"],
  ["glow", "Glow"],
  ["mesh", "Mesh"],
  ["grain", "Grain"],
  ["contours", "Contours"],
  ["watermark", "H watermark"],
  ["ribbon", "Ribbon"],
  ["paper", "Paper"],
  ["white", "White"],
  ["picture", "Your picture"],
];

export const DEFAULT_BACKGROUND: Background = "aura";

export function isBackground(v: unknown): v is Background {
  return typeof v === "string" && BACKGROUNDS.some(([b]) => b === v);
}

/* How the connection card shows a connection that is up. The first three
   (Halo, Orbit, Aurora, 2026-09-23) were soft blurred light and did not work;
   these are crisp, and each one means
   something: where you appear (map), the page's own dots lit from the H
   (dots), the state at a glance (blue card), a signal going out (rings), or
   the route alone (line). ConnectionCard sets `data-look`; globals.css draws
   each one under "Connected looks". */
export type ConnectLook = "map" | "dots" | "card" | "rings" | "line";

/** In the order Settings shows them, the default first: `[look, name, what it does]`.
    Blue card leads: the plainest "you are connected" at a glance, it keeps
    the card its usual size (the map adds a strip, which a phone feels), and
    it carries the H. A final pick replaces this default. */
export const CONNECT_LOOKS: readonly (readonly [ConnectLook, string, string])[] = [
  ["card", "Blue card", "The whole card turns blue while you are connected."],
  ["map", "Map", "The country you appear in lights up on a map of dots."],
  ["dots", "Dots", "The card's dots light up around the H."],
  ["rings", "Rings", "Thin rings go out from the H."],
  ["line", "Line", "Only the route lights up."],
];

export const DEFAULT_CONNECT_LOOK: ConnectLook = "card";

export function isConnectLook(v: unknown): v is ConnectLook {
  return typeof v === "string" && CONNECT_LOOKS.some(([l]) => l === v);
}

/** The browser preview shows a look without saving it: `?look=map|dots|card|rings|line`. */
export function previewConnectLook(search: string): ConnectLook | null {
  const l = new URLSearchParams(search).get("look");
  return isConnectLook(l) ? l : null;
}

/* The H in the middle of the route (2026-09-24): an on and off button of its
   own, or the card reshaped around it, instead of a sign that only lights up.
   The H is a second way to connect: pressing it does what the switch at the
   top of the card does, and that switch stays exactly as it is.
   - button: the H is a big button, like a VPN's connect button.
   - switch: the route is a switch: the H slides from this computer to the exit.
   - small: the H as it was before, a small round sign that lights up.
   With button and switch, the card also takes the H's corners while connected.
   ConnectionCard draws them; globals.css, "The H in the middle". */
export type HubStyle = "button" | "switch" | "small";

/** In the order Settings shows them, the default first: `[style, name, what it does]`. */
export const HUB_STYLES: readonly (readonly [HubStyle, string, string])[] = [
  ["button", "H button", "The H in the middle is a big button: press it to connect."],
  ["switch", "H switch", "The line is a switch: the H slides from this computer to the exit."],
  ["small", "Small H", "The H as it was: a small sign in the middle that lights up."],
];

export const DEFAULT_HUB_STYLE: HubStyle = "button";

export function isHubStyle(v: unknown): v is HubStyle {
  return typeof v === "string" && HUB_STYLES.some(([h]) => h === v);
}

/** The browser preview shows an H without saving it: `?hub=button|switch|small`. */
export function previewHubStyle(search: string): HubStyle | null {
  const h = new URLSearchParams(search).get("hub");
  return isHubStyle(h) ? h : null;
}

/** The two attributes for a background: the card surface and Aura's art. */
export function lookAttributes(bg: Background): { surface: "aura" | "paper" | "clean"; art?: string } {
  if (bg === "white") return { surface: "clean" };
  if (bg === "paper") return { surface: "paper" };
  if (bg === "aura") return { surface: "aura" };
  return { surface: "aura", art: bg };
}

const PICTURE_KEY = "hproxy-checker-background-picture";

export function loadPicture(): string | null {
  try {
    const p = localStorage.getItem(PICTURE_KEY);
    return p && p.startsWith("data:image/") ? p : null;
  } catch {
    return null;
  }
}

/** False when the storage refused it (too big for what is left): the screen says so. */
export function savePicture(dataUrl: string): boolean {
  try {
    localStorage.setItem(PICTURE_KEY, dataUrl);
    return true;
  } catch {
    return false;
  }
}

export function clearPicture(): void {
  try {
    localStorage.removeItem(PICTURE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Set the look on <html>. A picture background with no picture saved falls
    back to Aura, so the page is never left bare. */
export function applyLook(bg: Background, picture: string | null, root: HTMLElement = document.documentElement): void {
  const use = bg === "picture" && !picture ? DEFAULT_BACKGROUND : bg;
  const { surface, art } = lookAttributes(use);
  root.dataset.surface = surface;
  if (art) root.dataset.bg = art;
  else delete root.dataset.bg;
  if (use === "picture" && picture) root.style.setProperty("--bg-picture", `url("${picture}")`);
  else root.style.removeProperty("--bg-picture");
}

/** The size a picture is kept at: the longest side at most `max`, never
    enlarged. A 4000 px photo stored whole would not fit beside the settings. */
export function pictureSize(width: number, height: number, max = 1920): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Read an image file, scale it down and encode it as a JPEG data URL. */
export async function fileToPicture(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not a picture.");
  const bitmap = await createImageBitmap(file);
  const { width, height } = pictureSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`${thisDevice(true)} could not read the picture.`);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}
