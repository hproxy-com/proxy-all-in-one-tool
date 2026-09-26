/* The one helper the kit shares. Every visual value lives in
   src/styles/globals.css as a `ux-*` rule or a CSS variable, so a colour or a
   radius is changed in one place and both themes follow. */

/** Join class fragments, dropping the empty ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
