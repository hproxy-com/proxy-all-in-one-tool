/* The app's background: a setting, so people can make the app their own.

   Every one is solid (rebuilt 2026-10-02): Soft, the default, a calm grey page with white cards; plain
   white; warm paper; five crisp ones that draw lines or a blue band in solid
   colours; and a picture of the person's own. Aura (a blue and violet haze
   in the corners) and its studies are gone: a haze is a see-through tint,
   which the house rule never allows. A setting saved with one of them opens
   on Soft. The picture is scaled down and kept on this computer only,
   beside the settings, never sent anywhere.

   How it reaches the screen: two attributes on <html> that globals.css reads,
   `data-surface` (the cards and greys: soft, paper or clean) and `data-bg`
   (the art drawn on the page), and for a picture the CSS variable
   `--bg-picture`. `applyLook` sets them; main.tsx calls it before the first
   frame so the app never flashes the old look. */

import { thisDevice } from "./tauri";

export type Background = "soft" | "white" | "paper" | "band" | "blueprint" | "dotgrid" | "rings" | "diagonal" | "picture";

/** In the order the picker shows them, the default first. The crisp ones
    (2026-09-29) are pure white with lines, or brand blue at full strength. */
export const BACKGROUNDS: readonly (readonly [Background, string])[] = [
  ["soft", "Soft"],
  ["white", "White"],
  ["paper", "Paper"],
  ["band", "Blue band"],
  ["blueprint", "Blueprint"],
  ["dotgrid", "Dot grid"],
  ["rings", "Rings"],
  ["diagonal", "Diagonal"],
  ["picture", "Your picture"],
];

export const DEFAULT_BACKGROUND: Background = "soft";

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
  ["button", "Button", "A big button in the middle: press it to connect."],
  ["switch", "Switch", "The line is a switch: the H slides from this computer to the exit."],
  ["small", "Small", "A small sign that lights up; the switch sits in the corner."],
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

/** The crisp backgrounds: drawn on the pure white surface (styles/connect-designs.css). */
const CRISP: readonly Background[] = ["blueprint", "band", "rings", "diagonal", "dotgrid"];

/** The two attributes for a background: the card surface and the art drawn on the page. */
export function lookAttributes(bg: Background): { surface: "soft" | "paper" | "clean"; art?: string } {
  if (bg === "white") return { surface: "clean" };
  if (bg === "paper") return { surface: "paper" };
  if (CRISP.includes(bg)) return { surface: "clean", art: bg };
  if (bg === "picture") return { surface: "soft", art: "picture" };
  return { surface: "soft" };
}

/* The Connect page as a whole: the same pieces (ConnectionCard.tsx) laid out
   six ways, chosen in Settings, "Connect page"; Mix (the phone app's look,
   components/connect/mix/) is the first.
   Card is the page as it was, kept exactly; the others are new beside it.
   ConnectPanel.tsx picks the layout, ConnectDesigns.tsx draws the new ones,
   styles/connect-designs.css styles them. */
export type ConnectDesign = "mix" | "card" | "hero" | "map" | "bar" | "split";

/** In the order Settings shows them: `[design, name, what it is]`. */
export const CONNECT_DESIGNS: readonly (readonly [ConnectDesign, string, string])[] = [
  ["mix", "Mix", "The phone app's look: the map over the page, the switch in the middle."],
  ["card", "Card", "The connection on the left, where to go on the right."],
  ["hero", "Hero", "One column, like a VPN app: the big H in the middle."],
  ["map", "Map", "A world map across the top with your exit lit."],
  ["bar", "Bar", "One line on top; your proxies get the most room."],
  ["split", "Split", "A blue panel on the left carries the connection."],
];

export const DEFAULT_CONNECT_DESIGN: ConnectDesign = "mix";

export function isConnectDesign(v: unknown): v is ConnectDesign {
  return typeof v === "string" && CONNECT_DESIGNS.some(([d]) => d === v);
}

/** The browser preview shows a design without saving it: `?design=mix|card|hero|map|bar|split`. */
export function previewConnectDesign(search: string): ConnectDesign | null {
  const d = new URLSearchParams(search).get("design");
  return isConnectDesign(d) ? d : null;
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
    back to Soft, so the page is never left bare. */
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
