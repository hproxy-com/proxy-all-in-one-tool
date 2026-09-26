import { useEffect, useState } from "react";
import {
  GENTLE_CONCURRENCY_CEILING,
  MAX_CONCURRENCY,
  PROBE_PRESETS,
  type Protocols,
  type Settings as SettingsType,
} from "../lib/settings";
import { FRAUD_SERVICES, fraudService, testFraudService, type FraudKeys } from "../lib/fraud";
import { CONNECT_LOOKS, HUB_STYLES } from "../lib/look";
import { isMobile, isStoreInstall, setStartsWithComputer, startsWithComputer, thisDevice } from "../lib/tauri";
import {
  checkForUpdate,
  currentVersion,
  GOOGLE_PLAY_BUILD,
  GOOGLE_PLAY_URL,
  lastCheckedAt,
  MICROSOFT_STORE_URL,
  openManualDownload,
  openStorePage,
} from "../lib/updater";
import BackgroundPicker from "./BackgroundPicker";
import { Block, Button, ButtonGroup, Card, Check, Input, PageHead, Range } from "./ui";

/* Settings, in look D (2026-09-23): a grid of named blocks with plain titles
   in our blue, sliders with their reading on the right, our tick boxes, cut
   choice tracks, a divider under each block. Its own tab at the top;
   "Use with AI" moved out to a tab of its own. */

const PROTOCOL_LABEL: Record<keyof Protocols, string> = {
  http: "HTTP",
  https: "HTTPS",
  socks4: "SOCKS4",
  socks5: "SOCKS5",
};

/* The copy installed from the Microsoft Store (lib/tauri isStoreInstall): the
   Store updates it, and it does not start with the computer. */
function useStoreInstall(): boolean {
  const [store, setStore] = useState(false);
  useEffect(() => {
    void isStoreInstall().then(setStore);
  }, []);
  return store;
}

/* Version + a manual update check. Two things every desktop app owes its users:
   knowing which build you are running, and being able to ask for an update
   yourself rather than waiting to be told. */
function AboutBlock() {
  const store = useStoreInstall();
  const [version, setVersion] = useState("…");
  const [state, setState] = useState<"idle" | "checking" | "current" | "found">("idle");
  const [found, setFound] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(lastCheckedAt());

  useEffect(() => {
    void currentVersion().then(setVersion);
  }, []);

  const check = () => {
    setState("checking");
    // manual = true: an explicit ask takes even a previously skipped version.
    // A version found here starts downloading at once; the title bar offers
    // the restart when the bytes are ready.
    void checkForUpdate(true).then((info) => {
      setCheckedAt(lastCheckedAt());
      setFound(info?.version ?? null);
      setState(info ? "found" : "current");
    });
  };

  const ago = (t: number) => {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
  };

  const line =
    state === "checking"
      ? "Checking…"
      : state === "current"
        ? "You are on the latest version."
        : state === "found"
          ? `Version ${found} is downloading in the background. The title bar will offer a restart when it is ready.`
          : checkedAt
            ? `Last checked ${ago(checkedAt)}.`
            : "Updates are checked automatically.";

  if (isMobile() && GOOGLE_PLAY_BUILD) {
    return (
      <Block name="Version" value={`HProxy ${version}`} divider={false} hint="Installed from Google Play, which keeps HProxy up to date.">
        <Button variant="text" onClick={() => void openStorePage(GOOGLE_PLAY_URL)}>
          Google Play
        </Button>
      </Block>
    );
  }

  if (isMobile()) {
    return (
      <Block
        name="Version"
        value={`HProxy ${version}`}
        divider={false}
        hint="On a phone, updates come with the app package: the store, or a newer APK from the releases page."
      >
        <Button variant="text" onClick={() => void openManualDownload()}>
          Releases
        </Button>
      </Block>
    );
  }

  if (store) {
    return (
      <Block name="Version" value={`HProxy ${version}`} divider={false} hint="Installed from the Microsoft Store, which keeps HProxy up to date.">
        <Button variant="text" onClick={() => void openStorePage(MICROSOFT_STORE_URL)}>
          Microsoft Store
        </Button>
      </Block>
    );
  }

  return (
    <Block
      name="Updates"
      value={`HProxy ${version}`}
      divider={false}
      hint={`${line} Updates come from hproxy.com, and the app installs one only when it carries HProxy's signature and is newer than yours. While you use the app it waits for your click; while nobody does (the window in the tray, nothing connected, no check running), it installs by itself and the app comes back in the tray. An AI agent using HProxy keeps working through it.`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={state === "checking"} onClick={check}>
          Check for updates
        </Button>
        <Button variant="text" onClick={() => void openManualDownload()}>
          Download
        </Button>
      </div>
    </Block>
  );
}

/* Fraud scores: FFraud's free lookup, or the person's own API key at another
   service, switchable at any time. FFraud needs no key; the others take the person's own, kept on
   this computer. The test asks once, past the session's saved scores, so a
   new key is really tried. */
function FraudBlock({ settings, update }: { settings: SettingsType; update: (patch: Partial<SettingsType>) => void }) {
  const service = fraudService(settings.fraudService);
  const [test, setTest] = useState<{ busy: boolean; ok: boolean; text: string } | null>(null);
  useEffect(() => setTest(null), [settings.fraudService]);
  const keyId = service.id as keyof FraudKeys;
  const key = service.key ? (settings.fraudKeys[keyId] ?? "") : "";
  const runTest = () => {
    setTest({ busy: true, ok: false, text: "" });
    void testFraudService(settings.fraudService, settings.fraudKeys).then((r) => setTest({ busy: false, ...r }));
  };
  return (
    <Block
      name="Fraud score"
      hint={`How risky sites will take a proxy's address to be. Asked from ${thisDevice()} straight to the service picked here: only the address being scored goes there, nothing goes through HProxy, and keys stay on ${thisDevice()}. In Check, the scores come when you ask for them; in Connect, for the address you appear as.`}
    >
      <div className="flex flex-col gap-3">
        <ButtonGroup
          size="sm"
          value={settings.fraudService}
          onChange={(fraudService) => update({ fraudService })}
          options={FRAUD_SERVICES.map((s) => [s.id, s.id === "ffraud" ? "FFraud (free)" : s.name] as const)}
        />
        <p className="text-[13px] font-medium text-ink-mute">{service.about}</p>
        {service.key && (
          <Input
            type="password"
            value={key}
            onChange={(v) => update({ fraudKeys: { ...settings.fraudKeys, [keyId]: v } })}
            placeholder={service.key.placeholder}
            mono
            label={`${service.name} ${service.key.label}`}
          />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={runTest} disabled={test?.busy}>
            {test?.busy ? "Asking…" : `Test ${service.name}`}
          </Button>
          {test && !test.busy && (
            <span className={`text-[13px] font-semibold ${test.ok ? "text-ok" : "text-danger"}`}>{test.text}</span>
          )}
        </div>
        <Check
          on={settings.fraudOnConnect}
          onChange={(fraudOnConnect) => update({ fraudOnConnect })}
          label="Show the score of the address you appear as while connected"
        />
      </div>
    </Block>
  );
}

/* In the background, with no taskbar button. Closing the window hides
   it to the icon by the clock; starting with the computer is the person's
   choice and off until ticked. */
function BackgroundBlock({ keepRunning, setKeepRunning }: { keepRunning: boolean; setKeepRunning: (v: boolean) => void }) {
  const store = useStoreInstall();
  const [withComputer, setWithComputer] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void startsWithComputer()
      .then(setWithComputer)
      .catch(() => {});
  }, []);
  const toggleWithComputer = (on: boolean) => {
    setProblem(null);
    void setStartsWithComputer(on)
      .then(() => setWithComputer(on))
      .catch((e: unknown) => setProblem(String(e)));
  };
  return (
    <Block
      name="In the background"
      hint={`With the first one on, closing the window keeps HProxy running by the clock, connection and all, with no taskbar button. Click the icon to open it again; right-click it to connect, disconnect or quit. ${store ? "The Microsoft Store brings the updates." : "Updates install on their own while nobody is using the app."}`}
    >
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Check on={keepRunning} onChange={setKeepRunning} label="Keep running when the window closes" />
        {!store && <Check on={withComputer} onChange={toggleWithComputer} label="Start with the computer, in the background" />}
      </div>
      {problem && <p className="mt-3 text-[13px] font-semibold text-danger">{problem}</p>}
    </Block>
  );
}

export default function Settings({
  settings,
  setSettings,
}: {
  settings: SettingsType;
  setSettings: (s: SettingsType) => void;
}) {
  const update = (patch: Partial<SettingsType>) => setSettings({ ...settings, ...patch });
  const toggleProto = (k: keyof Protocols, on: boolean) => update({ protocols: { ...settings.protocols, [k]: on } });
  const highConcurrency = settings.concurrency > GENTLE_CONCURRENCY_CEILING;
  const seconds = Math.round(settings.timeoutMs / 1000);
  const probePreset = PROBE_PRESETS.find(([url]) => url === settings.connectProbeUrl);
  const probeChoice = probePreset ? probePreset[0] : "custom";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1200px] px-6 pb-8 pt-1.5 max-sm:px-3">
        <Card pad="roomy">
          <PageHead title="Settings" sub="How the checker probes, how hard it works your connection, and how the app looks." />

          {/* One column the width of the card on a phone, two from md. Without
              grid-cols-1 the single column is sized by its widest control, and
              one long tick box label pushed the page past a 360 px screen. */}
          <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-7 md:grid-cols-2">
            <Block
              name="Threads"
              value={settings.concurrency}
              hint={
                highConcurrency
                  ? `Above ${GENTLE_CONCURRENCY_CEILING} can overwhelm a home router and briefly drop your internet. For strong connections only.`
                  : "Proxies checked at the same time. A ceiling, not a target: the engine backs off when your line queues."
              }
            >
              <Range value={settings.concurrency} onChange={(v) => update({ concurrency: v })} min={1} max={MAX_CONCURRENCY} label="Threads" />
            </Block>

            <Block name="Timeout" value={`${seconds} s`} hint="How long to wait for each proxy before calling it a timeout.">
              <Range value={seconds} onChange={(v) => update({ timeoutMs: Math.max(1000, v * 1000) })} min={1} max={60} label="Timeout in seconds" />
            </Block>

            <Block name="Protocols" hint="Fewer protocols means fewer connections per proxy.">
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                {(Object.keys(PROTOCOL_LABEL) as (keyof Protocols)[]).map((k) => (
                  <Check key={k} on={settings.protocols[k]} onChange={(v) => toggleProto(k, v)} label={PROTOCOL_LABEL[k]} />
                ))}
              </div>
            </Block>

            <Block name="Retries" hint="Extra attempts for a proxy that did not answer.">
              <ButtonGroup
                size="sm"
                value={String(settings.retries)}
                onChange={(v) => update({ retries: Number(v) })}
                options={
                  [
                    ["0", "None"],
                    ["1", "One"],
                    ["2", "Two"],
                    ["3", "Three"],
                  ] as const
                }
              />
            </Block>

            <div className="md:col-span-2">
              <Block
                name="Where checking runs"
                /* Stated where the choice is made, not in a help page nobody
                   opens. Every mode that touches our servers sends credentials
                   with the list. Keep this, settings.ts and the README's "What
                   leaves your machine" table saying the same thing. */
                hint={
                  settings.source === "both"
                    ? `The fastest option. Your list is shared between our servers and ${thisDevice()} over one queue, so whichever side is quicker gets through more of it. Part of the list is sent to us, credentials included, and anything our servers cannot answer is checked here instead. Proxies locked to your own IP address fail from our side. Rows checked on our side carry no timing breakdown, exit address, leaked headers or software, and they are labelled.`
                    : settings.source === "api"
                      ? "Every connection is made from our hardware, so your address never touches the proxies you are testing and your own line stays free. Your whole list is sent to us, credentials included, and the results stream back with less detail: no timing breakdown, no exit address, no leaked headers, no software. Proxies locked to your own IP address fail from our side."
                      : "The default. Every connection is opened from here, so nothing about your proxies is transmitted, this is the only mode that returns the full detail, and proxies locked to your own IP address are judged correctly. On a large list that is thousands of connections from your own address, which is slower and is visible to your network and to every proxy you test."
                }
              >
                {/* Default first: the order of a set of pills reads as a recommendation. */}
                <ButtonGroup
                  value={settings.source}
                  onChange={(source) => update({ source })}
                  options={
                    [
                      ["local", thisDevice(true)],
                      ["both", "Both at once"],
                      ["api", "HProxy's servers"],
                    ] as const
                  }
                />
              </Block>
            </div>

            <Block
              name="Location and network"
              /* ⚠️ The second half is derived from the mode above rather than
                 asserted: a privacy claim that quietly goes stale is worse than
                 no claim. */
              hint={
                <>
                  The addresses you check are sent to HProxy&rsquo;s free IP API in batches. Never the ports, the credentials
                  or the results.{" "}
                  {settings.source === "local"
                    ? `Checking runs entirely on ${thisDevice()}, so turning this off means the app sends nothing at all.`
                    : "Checking is also running on our servers, so part of your list already reaches us either way."}
                </>
              }
            >
              <Check on={settings.geoLookup} onChange={(v) => update({ geoLookup: v })} label="Look up country, city and ISP" />
            </Block>

            <Block
              name="Extra measurements"
              hint="Each costs one more round trip per working proxy. UDP asks a SOCKS5 proxy to relay a datagram to our judge. Speed pulls a small payload through the proxy from our speed door and reports Mbit/s; both show in the row's detail."
            >
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Check on={settings.measureUdp} onChange={(v) => update({ measureUdp: v })} label="Test UDP on SOCKS5" />
                <Check on={settings.measureSpeed} onChange={(v) => update({ measureSpeed: v })} label="Measure download speed" />
              </div>
            </Block>

            <div className="md:col-span-2">
              <Block
                name="Connect check"
                value={probePreset ? probePreset[1] : "custom"}
                hint={
                  probePreset
                    ? `While connected, a request goes through the relay to this server every twenty seconds: ${probePreset[2]}. Our judge is the only server that can say which address you appear as; a Cloudflare trace page can too; anything else answers whether the tunnel works and how fast.`
                    : "Any http or https address. It answers whether the tunnel works and how fast; only our judge or a Cloudflare trace page can also say which address you appear as. Empty means our judge."
                }
              >
                <div className="flex flex-wrap items-center gap-3">
                  <ButtonGroup
                    size="sm"
                    value={probeChoice}
                    onChange={(v) => update({ connectProbeUrl: v === "custom" ? "" : v })}
                    options={[...PROBE_PRESETS.map(([url, name]) => [url, name] as const), ["custom", "Custom"] as const]}
                  />
                  {probeChoice === "custom" && (
                    <Input
                      value={settings.connectProbeUrl}
                      onChange={(v) => update({ connectProbeUrl: v })}
                      placeholder="https://example.com/"
                      width="short"
                      mono
                      label="Probe address"
                    />
                  )}
                </div>
              </Block>
            </div>

            <div className="md:col-span-2">
              <FraudBlock settings={settings} update={update} />
            </div>

            <div className="md:col-span-2">
              <Block
                name="Look"
                aside={
                  <ButtonGroup
                    size="sm"
                    value={settings.theme}
                    onChange={(theme) => update({ theme })}
                    options={
                      [
                        ["electric", "White"],
                        ["midnight", "Dark"],
                      ] as const
                    }
                  />
                }
                hint="White or dark (the moon in the title bar switches too), and what sits behind everything. Each picture below is the real page, small."
              >
                <BackgroundPicker value={settings.background} onChange={(background) => update({ background })} />
              </Block>
            </div>

            <div className="md:col-span-2">
              <Block name="The H in the middle" hint={HUB_STYLES.find(([h]) => h === settings.hubStyle)?.[2] ?? HUB_STYLES[0][2]}>
                <ButtonGroup
                  size="sm"
                  value={settings.hubStyle}
                  onChange={(hubStyle) => update({ hubStyle })}
                  options={HUB_STYLES.map(([h, name]) => [h, name] as const)}
                />
              </Block>
            </div>

            <div className="md:col-span-2">
              <Block
                name="When connected"
                hint={CONNECT_LOOKS.find(([l]) => l === settings.connectLook)?.[2] ?? CONNECT_LOOKS[0][2]}
              >
                <ButtonGroup
                  size="sm"
                  value={settings.connectLook}
                  onChange={(connectLook) => update({ connectLook })}
                  options={CONNECT_LOOKS.map(([l, name]) => [l, name] as const)}
                />
              </Block>
            </div>

            {!isMobile() && (
              <div className="md:col-span-2">
                <BackgroundBlock keepRunning={settings.keepRunning} setKeepRunning={(keepRunning) => update({ keepRunning })} />
              </div>
            )}

            <div className="md:col-span-2">
              <AboutBlock />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
