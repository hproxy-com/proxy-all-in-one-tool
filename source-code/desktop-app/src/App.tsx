import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import StartGate from "./components/StartGate";
import TitleBar, { type View } from "./components/TitleBar";
import ConnectPanel from "./components/connect/ConnectPanel";
import { ConnectionProvider } from "./components/connect/connection";
import ProxiesPage from "./components/ProxiesPage";
import CheckerPage from "./components/CheckerPage";
import HelpPage from "./components/HelpPage";
import Settings from "./components/Settings";
import UseWithAi from "./components/UseWithAi";
import PhoneShell from "./components/phone/PhoneShell";
import { loadSettings, saveSettings, type Settings as SettingsType } from "./lib/settings";
import { applyLook, loadPicture, previewConnectDesign, previewConnectLook, previewHubStyle } from "./lib/look";
import { slideIn } from "./lib/motion";
import { hexOf, movePage } from "./lib/phone";
import { isMobile, isTauri, phoneColors, setKeepRunning, zoneSetMatching } from "./lib/tauri";

/** A phone gets its own frame around the same pages (lib/phone.ts). */
const PHONE = isMobile();

/** Left to right, as the tabs stand (Use with AI is a computer's page). */
const VIEW_ORDER: Record<View, number> = { connect: 0, proxies: 1, checker: 2, ai: 3, help: 4, settings: 5 };

/** Connect is the main page. The browser preview's `?demo` opens the Checker
    and runs the sample; `?demo=connect` opens Connect, connected. */
function initialView(): View {
  if (typeof window === "undefined") return "connect";
  const demo = new URLSearchParams(window.location.search).get("demo");
  return demo !== null && demo !== "connect" ? "checker" : "connect";
}

export default function App() {
  const [view, setView] = useState<View>(initialView);
  // A page the app opens by itself ("All proxies", a proxy connected from a
  // list, a list pasted on Connect) slides on a phone the way a tab tap does.
  const viewNow = useRef(view);
  useEffect(() => {
    viewNow.current = view;
  }, [view]);
  const openView = useCallback((v: View) => {
    if (!PHONE || v === viewNow.current) {
      setView(v);
      return;
    }
    movePage(VIEW_ORDER[v] > VIEW_ORDER[viewNow.current] ? "next" : "prev", () => flushSync(() => setView(v)));
  }, []);
  // A computer: every page change (a tab, or a page the app opens by itself) slides in
  // from its tab's side (lib/motion.ts).
  const pageRef = useRef<HTMLDivElement>(null);
  const shown = useRef(view);
  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = view;
    if (PHONE || from === view) return;
    slideIn(pageRef.current, VIEW_ORDER[view] > VIEW_ORDER[from] ? "right" : "left");
  }, [view]);
  const [settings, setSettings] = useState<SettingsType>(() => loadSettings());
  const onSettings = (patch: Partial<SettingsType>) => setSettings((s) => ({ ...s, ...patch }));

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "midnight") root.setAttribute("data-theme", "midnight");
    else root.removeAttribute("data-theme");
  }, [settings.theme]);

  useEffect(() => {
    applyLook(settings.background, loadPicture());
  }, [settings.background]);

  // A phone draws its status bar over the page: its icons follow the page,
  // and the page's colour is kept for the first frame of the next start.
  useEffect(() => {
    if (!PHONE) return;
    void phoneColors(settings.theme === "midnight", hexOf(getComputedStyle(document.body).backgroundColor)).catch(() => {});
  }, [settings.theme, settings.background]);

  // Closing the window hides it to the tray while this is on.
  useEffect(() => {
    void setKeepRunning(settings.keepRunning).catch(() => {});
  }, [settings.keepRunning]);

  // The time zone match (Settings): the Rust side matches after each probe,
  // with Connect open or not, and needs to know whether it is on.
  useEffect(() => {
    void zoneSetMatching(settings.matchTimeZone).catch(() => {});
  }, [settings.matchTimeZone]);

  // The tray icon connects by itself, from the places the app keeps
  // (src-tauri/src/tray.rs): nothing here, and it works with the window closed.

  const toggleTheme = () =>
    setSettings((s) => ({ ...s, theme: s.theme === "midnight" ? "electric" : "midnight" }));

  // `?look=`, `?hub=` and `?design=` in the browser preview show a connected
  // look, an H and a Connect page design without saving them.
  const [lookOverride] = useState(() => (isTauri() || typeof window === "undefined" ? null : previewConnectLook(window.location.search)));
  const [hubOverride] = useState(() => (isTauri() || typeof window === "undefined" ? null : previewHubStyle(window.location.search)));
  const [designOverride] = useState(() => (isTauri() || typeof window === "undefined" ? null : previewConnectDesign(window.location.search)));
  const connectSettings = useMemo(
    () => ({
      ...settings,
      ...(lookOverride ? { connectLook: lookOverride } : {}),
      ...(hubOverride ? { hubStyle: hubOverride } : {}),
      ...(designOverride ? { connectDesign: designOverride } : {}),
    }),
    [settings, lookOverride, hubOverride, designOverride],
  );

  // A newer version first, then the screens (lib/startGate.ts). Outside the
  // ErrorBoundary's views, so a crash in a view never hides it. Each view
  // scrolls itself, because the checker's list virtualises against its own
  // scroll container.
  const pages = (
    <StartGate>
      <ErrorBoundary>
        {/* Proxies and the Checker stay alive behind the other pages: a
            check keeps running and its results are still there when you come
            back. The other pages start fresh each time. */}
        <div className={view === "proxies" ? "h-full" : "hidden"}>
          <ProxiesPage active={view === "proxies"} />
        </div>
        <div className={view === "checker" ? "h-full" : "hidden"}>
          <CheckerPage settings={settings} active={view === "checker"} />
        </div>
        {view === "connect" && <ConnectPanel settings={connectSettings} onSettings={onSettings} />}
        {/* Help keeps what is being written while another page shows. */}
        <div className={view === "help" ? "h-full" : "hidden"}>
          <HelpPage active={view === "help"} />
        </div>
        {view === "ai" && <UseWithAi />}
        {view === "settings" && <Settings settings={settings} setSettings={setSettings} />}
      </ErrorBoundary>
    </StartGate>
  );

  return (
    // The connection sits above every page and the title bar (its IP pill):
    // Connect and Proxies show the same one, and no page change touches it.
    <ConnectionProvider
      settings={connectSettings}
      onSettings={onSettings}
      active={view === "connect" || view === "proxies"}
      onConnectPage={view === "connect"}
      setView={openView}
    >
      {PHONE ? (
        <PhoneShell view={view} setView={setView} theme={settings.theme} toggleTheme={toggleTheme}>
          {pages}
        </PhoneShell>
      ) : (
        <div className="flex h-svh flex-col overflow-hidden bg-canvas text-ink">
          <TitleBar view={view} setView={setView} />
          {/* Wraps the views, not the title bar: a crash in a view must still
              leave the window controls usable, or the only way out is Task
              Manager. */}
          <div ref={pageRef} className="min-h-0 flex-1">
            {pages}
          </div>
        </div>
      )}
    </ConnectionProvider>
  );
}
