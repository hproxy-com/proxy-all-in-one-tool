/* Status colours, by token. The values live in globals.css (`--ok`, `--warn`,
   `--danger`) so they are the production tones on white and lifted tones on
   navy; a hex constant here was the reason "Elite" read as a dim green on the
   dark theme. */

export const GREEN = "var(--ok)";
export const RED = "var(--danger)";
export const AMBER = "var(--warn)";

export type Status = "pending" | "working" | "dead" | "timeout";

const tint = (token: string) => `color-mix(in srgb, var(${token}) 16%, transparent)`;

/** The colour, its soft fill, and the word for a row's status. */
export function statusStyle(status: Status): { color: string; tint: string; label: string } {
  if (status === "working") return { color: "var(--ok)", tint: tint("--ok"), label: "Working" };
  if (status === "timeout") return { color: "var(--warn)", tint: tint("--warn"), label: "Timeout" };
  if (status === "dead") return { color: "var(--danger)", tint: tint("--danger"), label: "Dead" };
  return { color: "var(--ink-soft)", tint: tint("--ink-soft"), label: "Testing" };
}
