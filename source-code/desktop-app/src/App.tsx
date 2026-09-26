import { useEffect, useMemo, useState } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import TitleBar, { type View } from "./components/TitleBar";
import CheckerConsole from "./components/checker/CheckerConsole";
import ConnectPanel from "./components/connect/ConnectPanel";
import Settings from "./components/Settings";
import History from "./components/History";
import UseWithAi from "./components/UseWithAi";
import { loadSettings, saveSettings, type Settings as SettingsType } from "./lib/settings";
import { freeListName, loadLists, makeList, saveLists, upsertList } from "./lib/saved";
import { applyLook, loadPicture, previewConnectLook, previewHubStyle } from "./lib/look";
import { connectRemembered } from "./lib/connectControl";
import { isTauri, onTrayConnect, setKeepRunning } from "./lib/tauri";

/** Connect is the main page. The browser preview's `?demo` opens Check and
    runs the sample; `?demo=connect` opens Connect, connected. */
function initialView(): View {
  if (typeof window === "undefined") return "connect";
  const demo = new URLSearchParams(window.location.search).get("demo");
  return demo !== null && demo !== "connect" ? "checker" : "connect";
}

export default function App() {
  const [view, setView] = useState<View>(initialView);
  const [settings, setSettings] = useState<SettingsType>(() => loadSettings());
  // A proxy line handed over from the checker's results ("Connect through
  // this one"), consumed by the Connect screen the moment it opens.
  const [connectLine, setConnectLine] = useState<string | undefined>(undefined);
  // A list the checker saved from its working rows, picked on Connect.
  const [connectListId, setConnectListId] = useState<string | undefined>(undefined);
  // Lines handed from Connect to the checker ("Check this list").
  const [checkSeed, setCheckSeed] = useState<{ text: string; at: number } | null>(null);

  const connectThrough = (raw: string) => {
    setConnectLine(raw);
    setView("connect");
  };
  const saveAsList = (lines: string[]) => {
    const lists = loadLists();
    const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const list = makeList(freeListName(lists, `Working ${day}`), lines, "every_connection", undefined);
    saveLists(upsertList(lists, list));
    setConnectListId(list.id);
    setView("connect");
  };
  const checkLines = (lines: string[]) => {
    setCheckSeed({ text: lines.join("\n"), at: Date.now() });
    setView("checker");
  };

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

  // Closing the window hides it to the tray while this is on.
  useEffect(() => {
    void setKeepRunning(settings.keepRunning).catch(() => {});
  }, [settings.keepRunning]);

  // The tray icon's "Connect": the place picked last, even with the window hidden.
  const probeUrl = settings.connectProbeUrl;
  useEffect(() => {
    let off: (() => void) | undefined;
    void onTrayConnect(() => {
      void connectRemembered(probeUrl).then((problem) => {
        if (problem) setView("connect");
      });
    }).then((u) => (off = u));
    return () => off?.();
  }, [probeUrl]);

  const toggleTheme = () =>
    setSettings((s) => ({ ...s, theme: s.theme === "midnight" ? "electric" : "midnight" }));

  // `?look=` and `?hub=` in the browser preview show a connected look and an H without saving them.
  const [lookOverride] = useState(() => (isTauri() || typeof window === "undefined" ? null : previewConnectLook(window.location.search)));
  const [hubOverride] = useState(() => (isTauri() || typeof window === "undefined" ? null : previewHubStyle(window.location.search)));
  const connectSettings = useMemo(
    () => ({ ...settings, ...(lookOverride ? { connectLook: lookOverride } : {}), ...(hubOverride ? { hubStyle: hubOverride } : {}) }),
    [settings, lookOverride, hubOverride],
  );

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-canvas text-ink">
      <TitleBar view={view} setView={setView} theme={settings.theme} toggleTheme={toggleTheme} />
      {/* Wraps the views, not the title bar: a crash in a view must still leave
          the window controls usable, or the only way out is Task Manager.
          Each view scrolls itself, because the checker's list virtualises
          against its own scroll container. */}
      <div className="min-h-0 flex-1">
        <ErrorBoundary>
          {/* The checker stays alive behind the other tabs: a run keeps going
              and its results are still there when you come back from Connect
              or History. The other screens start fresh each time. */}
          <div className={view === "checker" ? "h-full" : "hidden"}>
            <CheckerConsole
              active={view === "checker"}
              settings={settings}
              onConnect={connectThrough}
              onSaveList={saveAsList}
              seed={checkSeed}
            />
          </div>
          {view === "connect" && (
            <ConnectPanel
              initialLine={connectLine}
              onLineConsumed={() => setConnectLine(undefined)}
              initialListId={connectListId}
              onListConsumed={() => setConnectListId(undefined)}
              onCheckLines={checkLines}
              settings={connectSettings}
            />
          )}
          {view === "history" && <History />}
          {view === "ai" && <UseWithAi />}
          {view === "settings" && <Settings settings={settings} setSettings={setSettings} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
