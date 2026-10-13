import { useSyncExternalStore, type CSSProperties, type JSX } from "react";
import { PHONE_TABS, type PhoneTab } from "../../lib/phone";
import { isCheckRunning, subscribeCheckRunning } from "../../lib/runState";
import { Icon } from "../ui";

/* The phone's tabs, along the bottom where a thumb reaches them. Every tab
   keeps its word under its icon. The one you are on sits in a solid blue
   piece with the H's corners, which glides to the next tab and lands with a
   small give (styles/phone.css, "The tabs"). A check goes on while another
   tab is open; the Checker's tab carries a live dot meanwhile. */

export const TAB_NAMES: Record<PhoneTab, string> = {
  connect: "Connect",
  proxies: "Proxies",
  checker: "Checker",
  settings: "Settings",
};

const ICONS: Record<PhoneTab, (p: { className?: string }) => JSX.Element> = {
  connect: Icon.connect,
  proxies: Icon.layers,
  checker: Icon.listCheck,
  settings: Icon.settings,
};

export default function BottomNav({ tab, onTab }: { tab: PhoneTab; onTab: (t: PhoneTab) => void }) {
  const at = PHONE_TABS.indexOf(tab);
  const checking = useSyncExternalStore(subscribeCheckRunning, isCheckRunning);
  return (
    <nav className="ux-tabbar" aria-label="Screens" style={{ "--at": at } as CSSProperties}>
      <span className="glide" aria-hidden="true">
        {/* A new piece on each move, so its landing plays again. */}
        <i key={tab} />
      </span>
      {PHONE_TABS.map((t) => {
        const TabIcon = ICONS[t];
        return (
          <button key={t} type="button" className="ux-tabbar-tab" aria-current={t === tab ? "page" : undefined} onClick={() => onTab(t)}>
            <span className="icon">
              <TabIcon />
              {t === "checker" && checking && t !== tab && <i className="live" title="Checking" />}
            </span>
            <span className="label">{TAB_NAMES[t]}</span>
          </button>
        );
      })}
    </nav>
  );
}
