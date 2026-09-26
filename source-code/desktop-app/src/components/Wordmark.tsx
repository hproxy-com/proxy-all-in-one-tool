import HLetter from "./HLetter";

/**
 * The HProxy wordmark, the official lockup.
 *
 * The name is H-Proxy and the H is the logo. The letterform IS the H of the
 * word, so the word beside it is
 * "Proxy", closed by a blue period, set as one word: the mark in our blue,
 * the word in ink, as the design page's look D draws it
 * (hproxy-website/components/design/app-look/bits.tsx, `Brand`). The mark and
 * the word are not two things placed next to each other.
 *
 * Alignment is `inline-flex items-baseline` because Tailwind preflight sets
 * `vertical-align: middle` on svg, which sinks the mark below the text baseline.
 * The mark is `0.73em`: DM Sans cap height plus a hair of optical overshoot, so
 * it reads as the first letter of the word rather than as a picture in front of
 * it. Both numbers are lifted from the website's version, not re-derived.
 */
export default function Wordmark({
  className = "",
  /** On a dark or gradient surface: everything inherits the parent colour
      instead of keeping a blue that would disappear. */
  light = false,
  gid = "wm",
}: {
  className?: string;
  light?: boolean;
  gid?: string;
}) {
  return (
    <span translate="no" className={`inline-flex items-baseline font-bold tracking-[-0.025em] ${className}`}>
      <HLetter fill={light ? "current" : "blue"} gid={gid} className="mr-[0.07em] h-[0.73em] w-auto" />
      <span className={light ? "" : "text-ink"}>Proxy</span>
      <span className={light ? "opacity-60" : "text-digi"}>.</span>
    </span>
  );
}
