/* ============================================================
   CONTROLS — the form pieces, in look D's language (the `ux-*`
   rules in globals.css).

   BlockTitle  the name above a block of controls: plain words in
               our blue, and an optional value on the right (a
               slider's reading, a count).
   Block       BlockTitle plus the controls under it, with a 1 px
               divider under the block.
   Input       a filled field with even corners (you type into it,
               you do not press it), a blue edge while focused. On a
               panel it takes the page colour. `icon="search"` puts
               the magnifier inside it.
   Check       our tick box: the H's corners, an edge when empty,
               blue when on, and the tick draws itself.
   Range       a slim track, blue up to the value, and the switch's
               cut knob as the thumb.

   USAGE
     <Block name="Protocols">…checks…</Block>
     <Block name="Max latency" value="2 500 ms"><Range …/></Block>
     <Input value={v} onChange={setV} placeholder="8080, 80" label="Ports" />
     <Check on={x} onChange={setX} label="Only keep-alive" />
   ============================================================ */

import type { ClipboardEvent, CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react";
import { Icon } from "./Icon";
import { cx } from "./tokens";

export function BlockTitle({ name, value, aside }: { name: string; value?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="ux-title">
      <span className="name">{name}</span>
      {aside}
      {value != null && <span className="value num">{value}</span>}
    </div>
  );
}

export type BlockProps = {
  name: string;
  /** A reading on the right of the title: a slider's value, a count. */
  value?: ReactNode;
  /** A control on the right of the title instead: a small pill group. */
  aside?: ReactNode;
  /** One line under the title saying what the block does. */
  hint?: ReactNode;
  /** Draw the divider under the block. On by default. */
  divider?: boolean;
  children: ReactNode;
};

export function Block({ name, value, aside, hint, divider = true, children }: BlockProps) {
  return (
    <div className={cx("pb-5", divider && "ux-divider border-b")}>
      <BlockTitle name={name} value={value} aside={aside} />
      {hint && <p className="mt-2 text-[13.5px] font-medium leading-relaxed text-ink-mute">{hint}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

export type InputSize = "md" | "lg";
export type InputWidth = "full" | "short";

export type InputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: InputSize;
  width?: InputWidth;
  /** An icon inside the field, on the left: the magnifier of a search. */
  icon?: "search";
  /** Tabular figures for addresses, ports and numbers. */
  mono?: boolean;
  /** Draws the field in red. The message goes beside it, not in it. */
  invalid?: boolean;
  /** `password` for a secret the screen should not show: an API key. */
  type?: "text" | "number" | "password";
  min?: number;
  max?: number;
  /** Required: the accessible name. */
  label: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** A paste the field should not take as one line (a whole list, say). */
  onPaste?: (e: ClipboardEvent<HTMLInputElement>) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
};

export function Input({
  value,
  onChange,
  placeholder,
  size = "md",
  width = "full",
  icon,
  mono = false,
  invalid = false,
  type = "text",
  min,
  max,
  label,
  onKeyDown,
  onPaste,
  inputRef,
}: InputProps) {
  const field = (
    <input
      ref={inputRef}
      type={type}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className={cx(
        "ux-input",
        size === "lg" && "ux-input--lg",
        width === "short" && "ux-input--short",
        invalid && "is-invalid",
        mono && "num",
      )}
    />
  );
  if (!icon) return field;
  return (
    <span className="ux-field">
      <Icon.search />
      {field}
    </span>
  );
}

export type TextAreaProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Required: the accessible name. */
  label: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
};

/** The tinted text area. It fills its positioned parent, so the screen decides
    how tall it is by sizing the box around it. */
export function TextArea({ value, onChange, placeholder, label, inputRef }: TextAreaProps) {
  return (
    <textarea
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      className="ux-textarea absolute inset-0"
    />
  );
}

export type CheckProps = {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  /** A count after the label, muted. */
  count?: ReactNode;
  disabled?: boolean;
};

export function Check({ on, onChange, label, count, disabled = false }: CheckProps) {
  return (
    <label className={cx("ux-check", disabled && "pointer-events-none opacity-50")}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="dot">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5.5 12.5 10 17 18.5 8" />
        </svg>
      </span>
      <span className="text">{label}</span>
      {count != null && <span className="count num">{count}</span>}
    </label>
  );
}

export type RangeProps = {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Required: the accessible name. */
  label: string;
};

export function Range({ value, onChange, min, max, step = 1, label }: RangeProps) {
  // The blue part of the track: a native range cannot colour its own
  // progress in Chromium, so the component tells the stylesheet where it is.
  const at = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
      className="ux-range"
      style={{ "--at": Math.max(0, Math.min(100, at)) } as CSSProperties}
    />
  );
}
