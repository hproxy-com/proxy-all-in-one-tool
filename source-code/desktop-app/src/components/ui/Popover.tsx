/* ============================================================
   POPOVER — a button that opens a small panel under it, for a
   choice that needs more than one click to make (the checker's
   filters: which protocols, which countries, how fast).

   The button says what it is and, once it narrows something,
   what it is set to, lit in our blue. The panel is a solid sheet
   with the H's corners that drops in under the button (it moves,
   nothing fades). A click outside or Escape closes it; Escape
   then stops there, so it never also stops a running check.

   On a phone the panel comes up from the bottom in a sheet
   (phone/PhoneSheet.tsx), within the thumb's reach.

   USAGE
     <Popover label="Protocol" value="HTTPS, SOCKS5" on>
       …the choices…
     </Popover>
     <Popover label="Filters" icon={<Icon.filter />} count={2} on wide>
       …every group of choices…
     </Popover>

   The button has no fill (2026-10-12, no grey boxes): its words and icon, a hairline on hover, our blue once it
   narrows something, and with `count` how many things it narrows in a
   solid blue badge.
   ============================================================ */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isMobile } from "../../lib/tauri";
import PhoneSheet from "../phone/PhoneSheet";
import { Icon } from "./Icon";
import { cx } from "./tokens";

export type PopoverProps = {
  label: string;
  /** What it is set to, once it narrows something. */
  value?: string;
  /** It narrows something: the button is lit. */
  on?: boolean;
  /** Which edge of the button the panel hangs from. */
  align?: "left" | "right";
  /** Before the words. */
  icon?: ReactNode;
  /** How many things it narrows, in a badge after the words (0 shows none). */
  count?: number;
  /** A panel with room for its groups side by side. */
  wide?: boolean;
  children: ReactNode;
};

export function Popover({ label, value, on = false, align = "left", icon, count = 0, wide = false, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const phone = isMobile();

  useEffect(() => {
    if (!open || phone) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    // Caught on the way down, before the page's own Escape (which stops a check) hears it.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, phone]);

  return (
    <div ref={box} className="ux-pop">
      <button
        type="button"
        className={cx("ux-filterbtn", on && "is-on")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title={value ? `${label}: ${value}` : label}
      >
        {icon}
        <span className="name">{label}</span>
        {value && <span className="value">{value}</span>}
        {count > 0 && <span className="badge num">{count}</span>}
        <Icon.chevronDown className={cx("chev", open && "is-open")} />
      </button>
      {phone ? (
        <PhoneSheet open={open} onClose={() => setOpen(false)} title={label}>
          <div className={cx("ux-poppanel is-sheet", wide && "is-wide")}>{children}</div>
        </PhoneSheet>
      ) : (
        open && (
          <div className={cx("ux-poppanel", align === "right" && "is-right", wide && "is-wide")} role="dialog" aria-label={label}>
            {children}
          </div>
        )
      )}
    </div>
  );
}
