/* ============================================================
   CARD — a filled surface, no border.

   Look D (2026-09-23): one kind of container, a filled panel with
   even corners (you read it, you do not press it) on the white or
   midnight page. No outline, no shadow. Blocks inside it are
   separated by 1 px dividers in the page colour, never by boxes
   in boxes.

   2026-10-12, fewer boxes: a page's own content stands on
   the page itself (tone "flat": no surface, no corners, no side
   padding, so it lines up with the page's title and tabs); its
   fields and buttons are drawn as on the page, with a hairline
   (globals.css "Straight on the page").

   USAGE
     <Card>…</Card>                 the content panel
     <Card tone="flat">…</Card>     a page's content, straight on the page
     <Card tone="sunken">…</Card>   a tinted well inside it
     <Card fill>…</Card>            grows to fill a flex column
   ============================================================ */

import type { ReactNode } from "react";
import { cx } from "./tokens";

export type CardTone = "surface" | "sunken" | "flat";
export type CardPad = "none" | "tight" | "normal" | "roomy";

export type CardProps = {
  children: ReactNode;
  tone?: CardTone;
  pad?: CardPad;
  /** Clip children to the rounded corners. */
  clip?: boolean;
  /** Grow to fill the remaining space in a flex column. */
  fill?: boolean;
  /** Animate in on first paint: up and in, on the house curve. */
  enter?: boolean;
  as?: "div" | "section" | "article" | "aside";
};

/* Look D's density: 16 to 20 px inside a panel, where the unfx pass used
   2em everywhere. */
const PAD: Record<CardPad, string> = {
  none: "",
  tight: "p-4",
  normal: "p-5",
  roomy: "p-7",
};
/* On the page itself the room is above and below only: the content lines up with the page's edges. */
const FLAT_PAD: Record<CardPad, string> = {
  none: "",
  tight: "py-2",
  normal: "py-3",
  roomy: "py-4",
};

export function Card({
  children,
  tone = "surface",
  pad = "normal",
  clip = false,
  fill = false,
  enter = false,
  as: Tag = "div",
}: CardProps) {
  return (
    <Tag
      className={cx(
        tone === "sunken" ? "ux-panel--sunken" : tone === "flat" ? "ux-flat" : "ux-panel",
        tone === "flat" ? FLAT_PAD[pad] : PAD[pad],
        clip && "overflow-hidden",
        enter && "rise-in",
        // min-h-0 is not optional next to flex-1: without it a flex child
        // refuses to shrink below its content.
        fill && "flex min-h-0 flex-1 flex-col",
      )}
    >
      {children}
    </Tag>
  );
}
