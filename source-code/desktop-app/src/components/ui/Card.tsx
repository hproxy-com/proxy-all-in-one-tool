/* ============================================================
   CARD — a filled surface, no border.

   Look D (2026-09-23): one kind of container, a filled panel with
   even corners (you read it, you do not press it) on the white or
   midnight page. No outline, no shadow. Blocks inside it are
   separated by 1 px dividers in the page colour, never by boxes
   in boxes.

   USAGE
     <Card>…</Card>                 the content panel
     <Card tone="sunken">…</Card>   a tinted well inside it
     <Card fill>…</Card>            grows to fill a flex column
   ============================================================ */

import type { ReactNode } from "react";
import { cx } from "./tokens";

export type CardTone = "surface" | "sunken";
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
        tone === "sunken" ? "ux-panel--sunken" : "ux-panel",
        PAD[pad],
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
