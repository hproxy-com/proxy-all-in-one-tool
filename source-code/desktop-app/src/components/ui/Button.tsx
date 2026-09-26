/* ============================================================
   BUTTON — filled, with the H's corners (look D, 2026-09-23).

   Round at the top-left and bottom-right, nearly square at the
   other two, exactly like the crossbar of our H: the shape alone
   says "you can press this". It gives way under the finger and
   springs back (lib/press.ts). The unfx pill it replaced was one of
   the parts that made the app read as a copy.

   VARIANTS
     soft     the default: a filled button. Every ordinary action.
     solid    the one blue button a screen is for, with a sheen
              along the crossbar's diagonal and a light on hover.
     text     words only. Third-tier actions in a dense row.
     danger   red words on a pale red fill. Stop, disconnect.

   SIZES      sm 34 px · md 42 px · lg 52 px

   THE LAW: the author supplies values, this file and the `ux-btn`
   rules in globals.css own every visual decision, and there is no
   `className` prop.
   ============================================================ */

import type { ReactNode } from "react";
import { cx } from "./tokens";

export type ButtonVariant = "soft" | "solid" | "text" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container's width. */
  full?: boolean;
  disabled?: boolean;
  /** Marks the button as the current choice in a group: drawn solid. */
  selected?: boolean;
  title?: string;
  type?: "button" | "submit";
};

export function Button({
  children,
  onClick,
  variant = "soft",
  size = "md",
  full = false,
  disabled = false,
  selected = false,
  title,
  type = "button",
}: ButtonProps) {
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected || undefined}
      className={cx(
        "ux-btn",
        `ux-btn--${size}`,
        variant !== "soft" && `ux-btn--${variant}`,
        selected && "is-selected",
        full && "w-full",
      )}
    >
      {children}
    </button>
  );
}

/* ============================================================
   BUTTON GROUP — choosing one of a few: a cut track, the chosen
   one lit in our blue (not a white pill on grey, which is Apple's).
   The order reads as a recommendation, so the default goes first.
   ============================================================ */

export type ButtonGroupProps<T extends string> = {
  /** `[value, label]` pairs, default first. */
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
  size?: ButtonSize;
};

export function ButtonGroup<T extends string>({ options, value, onChange, size = "md" }: ButtonGroupProps<T>) {
  return (
    <div className={cx("ux-seg max-w-full", size === "sm" && "ux-seg--sm")} role="group">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={cx("ux-seg-btn", v === value && "is-on")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
