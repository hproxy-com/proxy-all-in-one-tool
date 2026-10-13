import { useEffect, useRef } from "react";

/* Ctrl+V anywhere on Connect or Proxies (unless a field has the keyboard)
   hands the text to `take`: one proxy goes into the field, a list opens the
   review, and on Groups a new group starts with it, so pasting a list takes
   no extra step. The paste event carries the text, so no clipboard
   permission is needed. */
export function usePasteAnywhere(active: boolean, take: (text: string) => void) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const takeRef = useRef(take);
  takeRef.current = take;

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!activeRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [contenteditable]") || t.isContentEditable)) return;
      const pasted = e.clipboardData?.getData("text") ?? "";
      if (!pasted.trim()) return;
      e.preventDefault();
      takeRef.current(pasted);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
}
