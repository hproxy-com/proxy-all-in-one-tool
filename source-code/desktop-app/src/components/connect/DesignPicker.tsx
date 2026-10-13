import { BACKGROUNDS, CONNECT_DESIGNS, type Background, type ConnectDesign } from "../../lib/look";
import { loadSettings, saveSettings, type Settings } from "../../lib/settings";

/* Browser preview only (ConnectPanel shows it when the window is not the
   desktop app): a small bar at the bottom to flip between the Connect page
   designs and the backgrounds while choosing (2026-09-29). The desktop app
   has the same choices in Settings, "Connect page" and "Look". */

export default function DesignPicker({
  design,
  background,
  onSettings,
}: {
  design: ConnectDesign;
  background: Background;
  onSettings: (patch: Partial<Settings>) => void;
}) {
  /* A `?design=` in the address wins over the setting (App.tsx); a pick here
     saves the setting and opens the page without it, so the pick shows. */
  const pick = (patch: Partial<Settings>) => {
    const url = new URL(window.location.href);
    if (patch.connectDesign && url.searchParams.has("design")) {
      saveSettings({ ...loadSettings(), ...patch });
      url.searchParams.delete("design");
      window.location.replace(url.toString());
      return;
    }
    onSettings(patch);
  };
  return (
    <div className="ux-designpicker" role="toolbar" aria-label="Connect page design and background">
      <span className="label">Design</span>
      {CONNECT_DESIGNS.map(([d, name, what]) => (
        <button key={d} type="button" aria-pressed={d === design} title={`${name}: ${what}`} onClick={() => pick({ connectDesign: d })}>
          {name}
        </button>
      ))}
      <span className="label">Background</span>
      <select value={background} aria-label="Background" onChange={(e) => pick({ background: e.target.value as Background })}>
        {BACKGROUNDS.filter(([b]) => b !== "picture").map(([b, name]) => (
          <option key={b} value={b}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}
