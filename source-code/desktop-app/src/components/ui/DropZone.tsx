import { cx } from "./tokens";

/** Icon.drop in its two parts, so the arrow can move while the tray stays. */
function DropMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" className="mark" aria-hidden="true">
      <path className="arrow" d="M12 3.5v10m0 0-4-4m4 4 4-4" />
      <path d="M4.5 14v5.5h15V14" />
    </svg>
  );
}

/* The right half of a list box (the Checker's, and Add's on My proxies): a file of proxies goes
   here. Since 2026-10-22 it is half the box, moves when a file is dragged in, and says it can be
   clicked too. While a file is held over the window, the half turns blue at its edge,
   its arrow keeps dropping into the tray and the words say where to let go; at rest it says it takes
   a drop, and shows "Choose a file" as a button (the whole half is that button). Nothing
   see-through: a hairline and the words change, nothing behind them. */
export function DropZone({ dragging, onChoose }: { dragging: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      className={cx("ux-dropzone", dragging && "is-dragging")}
      onClick={onChoose}
      title="A .txt or .csv file with your proxies, in any format"
    >
      <DropMark />
      {dragging ? (
        <>
          <b>Drop it here</b>
          <span>Let go to load your list</span>
        </>
      ) : (
        <>
          <b>Drop a file here</b>
          <span className="or">or</span>
          <span className="choose">Choose a file</span>
          <span className="kinds">.txt or .csv, any format</span>
        </>
      )}
    </button>
  );
}
