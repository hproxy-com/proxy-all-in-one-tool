/* ============================================================
   DROPDOWN — one button, a short list of actions under or above it.

   For the places a bar would otherwise grow a row of tiny buttons:
   export formats today, export shapes tomorrow. The menu is a
   filled sheet with a soft shadow; each row has a label and one
   line saying what it does. Click-away closes it.

   SPLIT (look D, 2026-09-23): with `onMain`, the button becomes two
   halves of one silhouette. The label half does the everyday thing
   at once (Export = the working list as .txt), the arrow half opens
   the other choices.

   USAGE
     <Dropdown label="Export" icon={<Icon.download />} onMain={txt} items={[
       { label: "Working list as .txt", note: "host:port, one per line", onClick: txt },
     ]} />
   ============================================================ */

import { useState, type ReactNode } from "react";
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
      {open && (
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
