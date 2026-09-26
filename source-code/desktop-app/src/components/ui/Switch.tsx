/* ============================================================
   SWITCH — the connection's on and off (look A's switch, 2026-09-23).

   Not a round knob on a pill, which is Apple's: a cut knob carrying
   our H slides across and the track lights up blue. While busy
   (connecting, moving to another exit) stripes run across the track.
   It presses like every control: the knob squashes under the finger
   and springs back (lib/press.ts, `.ux-switch` in globals.css).

   USAGE
     <Switch on={running} busy={busy} onChange={toggle} label="Connection" />
   ============================================================ */

import HLetter from "../HLetter";
import { cx } from "./tokens";

export type SwitchProps = {
  on: boolean;
  onChange: () => void;
  /** Required: what the switch turns on, for screen readers. */
  label: string;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
};

export function Switch({ on, onChange, label, busy = false, disabled = false, title }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy || undefined}
      title={title}
      disabled={disabled}
      onClick={onChange}
      className={cx("ux-switch", on && "is-on", busy && "is-busy")}
    >
      <span className="knob">
        <HLetter />
      </span>
    </button>
  );
}
