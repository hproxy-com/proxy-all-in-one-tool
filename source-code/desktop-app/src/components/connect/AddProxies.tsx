import { useEffect, type ReactNode } from "react";
import { ADD_FIRST } from "../../lib/connectionView";
import { Icon, cx } from "../ui";

/* Add your proxies (2026-10-18: "the paste the proxies in the software looks garbage, doesn't look
   well designed at all, should be a bigger button"): the paste lab's PC page (round 10; his "the
   app is perfect" at round 11) in the app. One big place to start: the words, then three big ways
   in: Paste (what you copied, one proxy or a whole list), Upload a file, Type one. A file or copied
   proxies dropped anywhere on the page work too (ProxiesPage.tsx). Sent here by the switch with none
   of yours, it says "Add your proxies first to start connecting!", popping in again on each press.
   No "or use a free one" under it: someone with proxies of their own adds them (round 14). */

export function AddProxies({
  asked,
  compact,
  problem,
  onPaste,
  onUpload,
  onType,
  onClose,
}: {
  /** When the switch last sent you here with none of yours (0: it did not). */
  asked: number;
  /** Over a list that already has proxies: less room around it. */
  compact: boolean;
  /** Why the last way in found nothing (an empty clipboard). */
  problem: string | null;
  onPaste: () => void;
  onUpload: () => void;
  onType: () => void;
  /** Over a list that has proxies, it can be put away (Escape too). */
  onClose?: () => void;
}) {
  useEffect(() => {
    if (!onClose) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <section className={cx("ux-add", compact && "is-compact")} aria-label="Add your proxies">
      {onClose && (
        <button type="button" className="ux-add-close" onClick={onClose} aria-label="Close" title="Close (Escape)">
          <Icon.cross />
        </button>
      )}
      <Icon.download className="ux-add-icon" />
      {asked ? (
        <div key={asked} className="ux-add-words rise-in" role="status">
          <h2>{ADD_FIRST}</h2>
          <p>Drag a file or copied proxies here, or paste them. As soon as they&rsquo;re in, you&rsquo;re connected.</p>
        </div>
      ) : (
        <div className="ux-add-words">
          <h2>Add your proxies</h2>
          <p>Drag a file or copied proxies here, or paste them. Any format.</p>
        </div>
      )}
      <div className="ux-add-ways">
        <button type="button" className="ux-add-way is-main" onClick={onPaste} title="What you copied: one proxy or a whole list">
          <Icon.clipboard />
          Paste
        </button>
        <button type="button" className="ux-add-way" onClick={onUpload} title="A .txt or .csv file with your proxies, in any format">
          <Icon.file />
          Upload a file
        </button>
        <button type="button" className="ux-add-type" onClick={onType} title="One proxy, read as you type">
          <Icon.key />
          Type one
        </button>
      </div>
      {problem && (
        <p className="ux-add-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** Type one: the paste field in a card of its own (the lab's round 14): any format, read as you
    type and tested by itself; its Add saves it, Cancel goes back. `field` is the page's LineField. */
export function TypeOne({ field }: { field: ReactNode }) {
  return (
    <section className="ux-typeone" aria-label="Type one">
      <div className="ux-add-words is-left">
        <h2>Type one</h2>
        <p>Any format. It&rsquo;s read as you type and tested by itself.</p>
      </div>
      {field}
    </section>
  );
}
