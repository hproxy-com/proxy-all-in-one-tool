import { useEffect, type KeyboardEvent as KeyEvent, type RefObject } from "react";
import { spacedN } from "../../lib/connect";
import { ADD_FIRST } from "../../lib/connectionView";
import { PASTE_LIST_HERE } from "../../lib/proxyExamples";
import { boxWords } from "../../lib/review";
import { Button, DropZone, Icon, TextArea } from "../ui";
import { useBoxLines } from "./lineReading";

/* Add your proxies. 2026-10-18: one big place to start. 2026-10-22: the Checker's box right here,
   in My proxies itself: type or paste one proxy or a whole list on the left, a file on the right,
   a hairline between.

   Since the same day, after three rounds of versions: no title over the box, Add and Paste what I
   copied at the page's top right (ProxiesPage.tsx), the box from top to bottom with the file's side
   a little narrower than the list's, and Add and test in the list's corner as a chat's Send.
   Adding is a page of its own: over a list, the list steps aside meanwhile (Destinations.tsx).

   A dropped or chosen file joins what is in the box (Destinations.tsx). Only lines the engine reads
   as proxies are counted; one that is not blocks nothing, the review says so and leaves it out
   (PasteReview.tsx). Add and test, or Ctrl+Enter, tests every line before it is kept; each paste
   becomes its own group in the list. Sent here by the switch with none of yours, it says "Add your
   proxies first to start connecting!", popping in again on each press. */

export function AddProxies({
  asked,
  problem,
  text,
  setText,
  boxRef,
  onUpload,
  onAdd,
  onClose,
  dragging = false,
}: {
  /** When the switch last sent you here with none of yours (0: it did not). */
  asked: number;
  /** Why the last way in found nothing (an empty clipboard). */
  problem: string | null;
  /** What is in the box. */
  text: string;
  setText: (v: string) => void;
  boxRef: RefObject<HTMLTextAreaElement | null>;
  /** Choose a file: it joins what is in the box. */
  onUpload: () => void;
  /** The lines of the box, to the test before they are kept. */
  onAdd: () => void;
  /** Over a list that has proxies, it can be put away (Escape too). */
  onClose?: () => void;
  /** A file is held over the page: the file's side says where it goes. */
  dragging?: boolean;
}) {
  useEffect(() => {
    if (!onClose) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  // Only the lines the engine reads as proxies count (lineReading.ts); an empty box says nothing.
  const box = useBoxLines(text);
  const canAdd = box.lines.length > 0;
  // Ctrl+Enter (⌘+Enter on a Mac) adds what is in the box, as a chat's box sends.
  const keys = (e: KeyEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || !canAdd) return;
    e.preventDefault();
    onAdd();
  };
  return (
    <section className="ux-add" aria-label="Add your proxies">
      {asked > 0 && (
        <div key={asked} className="ux-add-asked rise-in" role="status">
          <b>{ADD_FIRST}</b>
          <span>Type or paste them here, or drop a file. As soon as they&rsquo;re in, you&rsquo;re connected.</span>
        </div>
      )}
      <div className="ux-listbox ux-add-box">
        <div className="relative min-h-[230px] min-w-0 flex-1">
          <TextArea value={text} onChange={setText} placeholder={PASTE_LIST_HERE} label="Your proxies" inputRef={boxRef} onKeyDown={keys} />
          <div className="ux-add-corner">
            <span className="ready num">{boxWords(box.ready)}</span>
            {problem && (
              <p className="ux-add-problem" role="alert">
                {problem}
              </p>
            )}
            <span className="ux-add-keys" aria-hidden="true">
              <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
            </span>
            {onClose && (
              <Button variant="text" onClick={onClose} title="Put it away (Escape)">
                Cancel
              </Button>
            )}
            <button type="button" className="ux-add-way is-main" onClick={onAdd} disabled={!canAdd} title="Every one is tested before it is kept (Ctrl+Enter)">
              <Icon.plus />
              {box.ready ? `Add and test ${spacedN(box.ready)}` : "Add and test"}
            </button>
          </div>
        </div>
        <DropZone dragging={dragging} onChoose={onUpload} />
      </div>
    </section>
  );
}
