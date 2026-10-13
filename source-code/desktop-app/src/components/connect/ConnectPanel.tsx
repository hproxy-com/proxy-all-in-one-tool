import type { Settings } from "../../lib/settings";
import { isTauri } from "../../lib/tauri";
import { Icon } from "../ui";
import ConnectionCard from "./ConnectionCard";
import ConnectDesignView from "./ConnectDesigns";
import DesignPicker from "./DesignPicker";
import RecentPlaces from "./RecentPlaces";
import { useConnection } from "./connection";

/* Connect: the connection and nothing else, a page of its own beside the
   proxy list, like a VPN app's main screen:
   the state, one switch, where you appear, the leak check, and the places
   used last one press away. Adding and managing places, the free pool and
   the checker are the Proxies page (ProxiesPage.tsx); "Change" on the card
   and "All proxies" go there. The connection itself lives above both pages
   (connection.tsx), so leaving this page never touches it.

   How it is laid out is a setting (Settings, Look, "Connect page";
   lib/look.ts CONNECT_DESIGNS): Card is drawn here, the others by
   ConnectDesigns.tsx. */

export default function ConnectPanel({ settings, onSettings }: { settings: Settings; onSettings: (patch: Partial<Settings>) => void }) {
  const { card, drag } = useConnection();
  const note = !isTauri() && (
    <p className="px-1 text-[12.5px] font-medium text-ink-soft">Browser preview: the relay is pretend here.</p>
  );
  const side = <RecentPlaces />;

  return (
    // overflow-x-hidden: nothing on this page may make it scroll sideways (the
    // connected looks' art is wider than the card, clipped to it).
    <div className="relative h-full overflow-y-auto overflow-x-hidden" onDragOver={drag.onDragOver} onDragLeave={drag.onDragLeave} onDrop={drag.onDrop}>
      {settings.connectDesign === "card" ? (
        <div className="mx-auto grid max-w-[1180px] items-start gap-4 px-6 pb-8 pt-1.5 max-sm:px-3 lg:grid-cols-[minmax(0,6fr)_minmax(0,4fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <ConnectionCard {...card} />
            {note}
          </div>
          <div className="min-w-0 lg:sticky lg:top-1.5">{side}</div>
        </div>
      ) : (
        <ConnectDesignView design={settings.connectDesign} card={card} side={side} note={note} />
      )}
      {!isTauri() && <DesignPicker design={settings.connectDesign} background={settings.background} onSettings={onSettings} />}
      {drag.active && (
        <div className="drop-veil" aria-hidden="true">
          <span>
            <Icon.drop className="h-7 w-7" />
            Drop your proxies
          </span>
        </div>
      )}
    </div>
  );
}
