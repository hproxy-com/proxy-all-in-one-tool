import { useRef, useState, type CSSProperties } from "react";
import { applyLook, BACKGROUNDS, clearPicture, fileToPicture, loadPicture, savePicture, type Background } from "../lib/look";
import { thisDevice } from "../lib/tauri";
import { cx } from "./ui";

/* The background picker (Settings, Look), so people can make the app their
   own. Each choice is a miniature of the real page: the same CSS rules
   at 15 % of the window, with frosted cards where the app's cards sit, so
   what you pick is what you get. The last one is a picture of your own,
   scaled down and kept on this computer only. */

export default function BackgroundPicker({ value, onChange }: { value: Background; onChange: (b: Background) => void }) {
  const [picture, setPicture] = useState<string | null>(() => loadPicture());
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const choose = async (file: File) => {
    setError(null);
    try {
      const p = await fileToPicture(file);
      if (!savePicture(p)) {
        setError(`That picture is too big to keep on ${thisDevice()}. A smaller one fits.`);
        return;
      }
      setPicture(p);
      onChange("picture");
      // Picking a new picture while the old one shows changes no setting, so
      // the page is repainted here.
      applyLook("picture", p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = () => {
    clearPicture();
    setPicture(null);
    if (value === "picture") onChange("aura");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-choices" role="radiogroup" aria-label="Background">
        {BACKGROUNDS.map(([b, name]) => {
          const isPicture = b === "picture";
          const empty = isPicture && !picture;
          return (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={value === b}
              className={cx("bg-choice", value === b && "is-on")}
              onClick={() => (empty ? fileRef.current?.click() : onChange(b))}
              title={empty ? `Choose a picture from ${thisDevice()}` : name}
            >
              <span className="bg-thumb">
                {empty ? (
                  <span className="add">+ Choose a picture</span>
                ) : (
                  <span
                    className="bg-preview"
                    data-bg={b}
                    style={isPicture ? ({ "--bg-picture": `url("${picture}")` } as CSSProperties) : undefined}
                  >
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </span>
              <span>{name}</span>
            </button>
          );
        })}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void choose(f);
        }}
      />
      <div className="flex flex-wrap items-center gap-4 text-[13px] font-medium text-ink-mute">
        {picture ? (
          <>
            <button type="button" className="ux-link" onClick={() => fileRef.current?.click()}>
              Change the picture
            </button>
            <button type="button" className="ux-link" onClick={remove}>
              Remove it
            </button>
            <span>Kept on {thisDevice()} only, never sent anywhere.</span>
          </>
        ) : (
          <span>Aura is the default. Your own picture stays on {thisDevice()} and is never sent anywhere.</span>
        )}
        {error && <span className="font-semibold text-danger">{error}</span>}
      </div>
    </div>
  );
}
