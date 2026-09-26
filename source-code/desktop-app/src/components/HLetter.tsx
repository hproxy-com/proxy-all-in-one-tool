/**
 * The real HProxy letterform, the same paths the website's logo draws.
 *
 * Three paths on a 22x26 grid: a left stem with a rounded shoulder, a straight
 * right stem, and the ribbon that sweeps between them. The letterform never
 * changes; only the fill does.
 *
 * ⚠️ This app previously drew its own mark: a blue rounded square with a
 * capital H typed inside it. That is not the logo. It is a made-up tile that
 * happens to contain the right letter, and it appeared in the title bar of
 * every window. The real mark is a specific letterform, and the wordmark is
 * built so that this letterform IS the H of "HProxy" rather than sitting beside
 * it. Improvising a logo is the one thing no component is allowed to do.
 *
 * `gid` must be unique per instance when the gradient fill is used, because SVG
 * gradient ids are document-global: two lockups sharing an id means the second
 * references the first one's gradient, which looks fine right up until the
 * first is conditionally removed.
 */

const STEM_LEFT = "M0 0V0C3.98547 0 7.21633 3.23086 7.21633 7.21633V26H0V0Z";
const RIBBON =
  "M7.2349 26H0V15.9714C0 12.4548 2.85076 9.60408 6.36735 9.60408H14.2204V0H21.4367V10.4531C21.4367 13.9696 18.586 16.8204 15.0694 16.8204H7.2349V26Z";

export type HLetterProps = {
  className?: string;
  /** `blue` paints the design-system gradient; `current` inherits text colour. */
  fill?: "blue" | "current";
  gid?: string;
};

export default function HLetter({ className = "", fill = "current", gid = "hx" }: HLetterProps) {
  const paint = fill === "blue" ? `url(#${gid}-a)` : "currentColor";
  return (
    <svg viewBox="0 0 22 26" fill="none" className={className} aria-hidden="true">
      {fill === "blue" && (
        <defs>
          <linearGradient id={`${gid}-a`} x1="0" y1="0" x2="22" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: "var(--digi-light)" }} />
            <stop offset="0.5" style={{ stopColor: "var(--digi)" }} />
            <stop offset="1" style={{ stopColor: "var(--digi-deep)" }} />
          </linearGradient>
        </defs>
      )}
      <path d={STEM_LEFT} fill={paint} />
      <rect x="14.2188" width="7.21633" height="26" fill={paint} />
      <path d={RIBBON} fill={paint} />
    </svg>
  );
}
