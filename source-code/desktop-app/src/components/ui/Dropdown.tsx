/* ============================================================
   DROPDOWN — one button, a short list of actions under or above it.

   For the places a bar would otherwise grow a row of tiny buttons:
   export formats today, export shapes tomorrow. The menu is a
   filled sheet with a soft shadow; each row has a label and one
   line saying what it does. Click-away or Escape closes it (Escape
   was missing until 2026-10-12: the Checker's Export menu stayed
   open over the list), and Escape stops there, so it never also
   stops a running check.

   SPLIT (look D, 2026-09-23): with `onMain`, the button becomes two
   halves of one silhouette. The label half does the everyday thing
   at once (Export = the working list as .txt), the arrow half opens
   the other choices.

   On a phone the choices come up from the bottom in a sheet
   (phone/PhoneSheet.tsx), within the thumb's reach; Back closes it.

   USAGE
     <Dropdown label="Export" icon={<Icon.download />} onMain={txt} items={[
       { label: "Working list as .txt", note: "as you gave them, with the logins, one per line", onClick: txt },
     ]} />
   ============================================================ */

import { useEffect, useState, type ReactNode } from "react";
import { isMobile } from "../../lib/tauri";
import PhoneSheet, { SheetItem } from "../phone/PhoneSheet";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { Icon } from "./Icon";
import { cx } from "./tokens";

export type DropdownItem = {
  label: string;
  note?: string;
  onClick: () => void;
};

export type DropdownProps = {
  label: string;
  items: DropdownItem[];
  /** An icon before the label. */
  icon?: ReactNode;
  /** Makes it a split button: the label half runs this, the arrow opens the menu. */
  onMain?: () => void;
  size?: ButtonSize;
  variant?: ButtonVariant;
  /** Which edge of the trigger the menu hangs from. */
  align?: "left" | "right";
  /** Near the bottom of the window, a menu opens up. */
  opens?: "down" | "up";
  disabled?: boolean;
};

export function Dropdown({
  label,
  items,
  icon,
  onMain,
  size = "md",
  variant = "soft",
  align = "right",
  opens = "down",
  disabled = false,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  // Caught on the way down, before the page's own Escape (which stops a check) hears it.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);
  const arrow = (
    <Icon.chevronDown className={cx("h-4 w-4 transition-transform", open !== (opens === "up") && "rotate-180")} />
  );
  return (
    <div className="relative">
      {onMain ? (
        <span className="ux-split">
          <Button variant={variant} size={size} disabled={disabled} onClick={onMain} title={label}>
            {icon}
            <span className="ux-btn-label">{label}</span>
          </Button>
          <Button variant={variant} size={size} selected={open} disabled={disabled} onClick={() => setOpen((v) => !v)} title={`${label} as…`}>
            {arrow}
          </Button>
        </span>
      ) : (
        <Button variant={variant} size={size} selected={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>
          {icon}
          {label}
          {arrow}
        </Button>
      )}
      {isMobile() ? (
        <PhoneSheet open={open} onClose={() => setOpen(false)} title={label}>
          {items.map((it) => (
            <SheetItem
              key={it.label}
              label={it.label}
              note={it.note}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            />
          ))}
        </PhoneSheet>
      ) : open && (
        <>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div
            className={cx(
              "ux-sheet rise-in absolute z-50 min-w-[300px] !rounded-[16px_6px_16px_6px] p-2",
              align === "right" ? "right-0" : "left-0",
              opens === "up" ? "bottom-full mb-2" : "top-full mt-2",
            )}
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className="ux-menuitem"
              >
                <span className="text-[14px] font-bold">{it.label}</span>
                {it.note && <span className="note">{it.note}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
