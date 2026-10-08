/* ============================================================
   ICONS — drawn for us, not taken from an icon set.

   Square line ends and sharp joins, like the straight cuts of the
   H, where Feather and Lucide (in every other app) use round ends.
   "Copy" carries the H's corners outright: two squares cut like the
   crossbar. "Settings" is three sliders with square knobs (a toothed
   wheel read as a sun at 17 px). Ported from the design page
   (hproxy-website/components/design/app-look/bits.tsx) with look D,
   2026-09-23, plus the sun and moon of the theme switch.

   USAGE   <Icon.copy className="h-4 w-4" />
   Size and colour come from the parent (currentColor), so an icon
   inside a control takes the control's colour.
   ============================================================ */

type IconProps = { className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "square" as const,
  strokeLinejoin: "miter" as const,
};

export const Icon = {
  search: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
  ),
  /** Two squares with the crossbar's corners, the back one half hidden. */
  copy: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M9 12.5A3.5 3.5 0 0 1 12.5 9H20v7.5a3.5 3.5 0 0 1-3.5 3.5H9Z" />
      <path d="M9 15H4V7.5A3.5 3.5 0 0 1 7.5 4H15v5" />
    </svg>
  ),
  chevronDown: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="m7 10 5 5 5-5" />
    </svg>
  ),
  chevronRight: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="m10 7 5 5-5 5" />
    </svg>
  ),
  arrowRight: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M5 12h12m-4.5-4.5L17 12l-4.5 4.5" />
    </svg>
  ),
  /** Settings: three sliders with square knobs. */
  settings: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M4 7h4M12 7h8M4 12h9M17 12h3M4 17h2M10 17h10" />
      <path d="M8 5h4v4H8ZM13 10h4v4h-4ZM6 15h4v4H6Z" fill="currentColor" strokeWidth={1} />
    </svg>
  ),
  shield: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M12 3.5 5 6.5v5c0 4.1 2.8 7.8 7 9 4.2-1.2 7-4.9 7-9v-5l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  check: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M5.5 12.5 9.5 16.5 18.5 7.5" />
    </svg>
  ),
  cross: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M7.5 7.5l9 9M16.5 7.5l-9 9" />
    </svg>
  ),
  /** The checker: a list with ticks. */
  listCheck: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="m4 7 1.5 1.5L8 6M4 13l1.5 1.5L8 12M4 19l1.5 1.5L8 18M12 7h8M12 13h8M12 19h8" />
    </svg>
  ),
  /** Connect: two ends joined. */
  /** Connect: a plug, two square prongs and its cord (it replaced two joined
      rings on 2026-09-24). */
  connect: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M9 3v4M15 3v4" />
      <path d="M6 7h12v3.5a6 6 0 0 1-12 0Z" />
      <path d="M12 16.5V21" />
    </svg>
  ),
  /** A triangle with a mark: something to know before using what follows. */
  warning: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M12 4 21 19.5H3Z" />
      <path d="M12 10v4.5M12 17v.5" />
    </svg>
  ),
  clock: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  download: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M12 4.5v10m0 0-4-4m4 4 4-4M5.5 19h13" />
    </svg>
  ),
  refresh: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M19 12a7 7 0 1 1-2.05-4.95" />
      <path d="M19 4v4h-4" />
    </svg>
  ),
  /** Stop or disconnect: the power mark. */
  power: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M12 3.5v7" />
      <path d="M7.05 8.05a7 7 0 1 0 9.9 0" />
    </svg>
  ),
  layers: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
    </svg>
  ),
  globe: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5Z" />
    </svg>
  ),
  laptop: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <rect x="4.5" y="5" width="15" height="10" rx="1.5" />
      <path d="M3 19h18" />
    </svg>
  ),
  /** The phone the app runs on: where the route starts on Android and iOS. */
  phone: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <rect x="7" y="3.5" width="10" height="17" rx="1.5" />
      <path d="M11 17h2" />
    </svg>
  ),
  /** Use with AI: a four-point spark, the mark people read as "an assistant". */
  spark: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M12 3.5 13.9 10.1 20.5 12 13.9 13.9 12 20.5 10.1 13.9 3.5 12 10.1 10.1Z" />
      <path d="M19 3.5v3M17.5 5h3" />
    </svg>
  ),
  /** Code: two angle brackets, for an editor shown without its mark. */
  code: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.5 5.5l-3 13" />
    </svg>
  ),
  /** A terminal prompt, for commands to paste. */
  terminal: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M4.5 5h15v14h-15Z" />
      <path d="m8 10 2.5 2.5L8 15M13 15h3" />
    </svg>
  ),
  /** Drop a file here: an arrow into an open tray. */
  drop: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M12 3.5v10m0 0-4-4m4 4 4-4M4.5 14v5.5h15V14" />
    </svg>
  ),
  /** A file: a page with its corner folded. */
  file: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M6.5 3.5h7.5l4 4v13h-11.5Z" />
      <path d="M13.5 3.5V8h4.5M9.5 12.5h5M9.5 16h5" />
    </svg>
  ),
  plus: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M12 5.5v13M5.5 12h13" />
    </svg>
  ),
  /** Edit: a pencil with a square nib. */
  edit: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M15.5 5.5 18.5 8.5 9 18H6v-3Z" />
      <path d="M13.5 7.5l3 3" />
    </svg>
  ),
  trash: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7" />
    </svg>
  ),
  /** White mode: a sun with square rays. */
  sun: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
    </svg>
  ),
  /** Dark mode: a crescent. */
  moon: ({ className }: IconProps) => (
    <svg viewBox="0 0 24 24" {...stroke} className={className} aria-hidden="true">
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  ),
};
