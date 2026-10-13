import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import {
  GENTLE_CONCURRENCY_CEILING,
  MAX_CONCURRENCY,
  PROBE_PRESETS,
  type Protocols,
  type Settings as SettingsType,
} from "../lib/settings";
import { FRAUD_SERVICES, fraudServicesOf, missingKey, testFraudService, type FraudKeys, type FraudService } from "../lib/fraud";
import { CONNECT_DESIGNS, CONNECT_LOOKS, HUB_STYLES } from "../lib/look";
import {
  installChannel,
  isMobile,
  isStoreInstall,
  openExternal,
  setStartsWithComputer,
  startsWithComputer,
  thisDevice,
  zoneStatus,
  type Channel,
  type ZoneStatus,
} from "../lib/tauri";
import { DATE_TIME_SETTINGS } from "../lib/leaks";
import {
  checkForUpdate,
  currentVersion,
  GOOGLE_PLAY_URL,
  lastCheckedAt,
  MICROSOFT_STORE_URL,
  openManualDownload,
  openStorePage,
} from "../lib/updater";
import { updatesItself } from "../lib/versions";
import { slideIn } from "../lib/motion";
import BackgroundPicker from "./BackgroundPicker";
import { pushPage, usePhoneSub } from "./phone/PhoneShell";
import { Button, ButtonGroup, Card, Check, Icon, InfoTip, Input, PageHead, Range, Tag, cx, useSlidingPill } from "./ui";

/* Settings: four sections in a nav of their own (2026-09-30), one shown at a
   time, each setting one line: its name, the "i", the control.

   Since 2026-10-02 the screen holds no long sentences, everything on it
   explains itself, and every explanation, the privacy statements included,
   sits behind an "i" beside the name instead of in a line under it, word for word where it states what leaves this computer.
   Stated where the choice is made, never in a help page; just not as a wall
   of text. A line under a name is left only for what is happening now (a
   warning, an update downloading).

   On a phone the four sections are a list, the way a phone's own settings
   are: a section opens a step deeper, sliding in, with its name and the way
   back in the top bar (phone/PhoneShell.tsx), and Back returns to the list. */

/* The privacy policy, reachable from inside the app: Google Play asks for it here as well as on
   the store page (2026-09-28). hproxy.com/privacy has the section "The HProxy app and browser
   extension", which says what PRIVACY.md at the root of this repository says. */
const PRIVACY_POLICY_URL = "https://hproxy.com/privacy";

const PROTOCOL_LABEL: Record<keyof Protocols, string> = {
  http: "HTTP",
  https: "HTTPS",
  socks4: "SOCKS4",
  socks5: "SOCKS5",
};

type SectionId = "checking" | "connect" | "look" | "app";
const SECTIONS: readonly { id: SectionId; name: string; icon: (p: { className?: string }) => JSX.Element }[] = [
  { id: "checking", name: "Checking", icon: Icon.listCheck },
  { id: "connect", name: "Connect", icon: Icon.connect },
  { id: "look", name: "Look", icon: Icon.sun },
  { id: "app", name: "App", icon: Icon.settings },
];
const SECTION_KEY = "hproxy-settings-section";

function loadSection(): SectionId {
  try {
    const s = localStorage.getItem(SECTION_KEY);
    if (SECTIONS.some((x) => x.id === s)) return s as SectionId;
  } catch {
    /* a private window: the first section */
  }
  return "checking";
}

/** One setting: its name, the "i" with the explanation, a reading, and the
    control on the right (under it with `stacked`). `note` is one short line
    for what is happening now, never an explanation. */
function Row({
  name,
  info,
  value,
  note,
  stacked = false,
  children,
}: {
  name: string;
  info?: ReactNode;
  value?: ReactNode;
  note?: ReactNode;
  stacked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cx("ux-setrow", stacked && "is-stacked")}>
      <div className="text">
        <div className="name">
          {name}
          {info && <InfoTip label={name}>{info}</InfoTip>}
          {value != null && <span className="value num">{value}</span>}
        </div>
        {note && <p className="note">{note}</p>}
      </div>
      {children != null && <div className="control">{children}</div>}
    </div>
  );
}

/* The copy installed from the Microsoft Store (lib/tauri isStoreInstall): the
   Store updates it, and it does not start with the computer. */
function useStoreInstall(): boolean {
  const [store, setStore] = useState(false);
  useEffect(() => {
    void isStoreInstall().then(setStore);
  }, []);
  return store;
}

/* Where this copy came from (lib/tauri installChannel), which is where its updates come from.
   Null until known, and in a plain browser. */
function useChannel(): Channel | null {
  const [channel, setChannel] = useState<Channel | null>(null);
  useEffect(() => {
    void installChannel().then(setChannel);
  }, []);
  return channel;
}

/* Version + a manual update check. Two things every app owes its users: knowing which build
   you are running, and being able to ask for an update yourself rather than waiting to be told.
   Each kind of copy says who keeps it current. */
function UpdatesRow() {
  const channel = useChannel();
  const [version, setVersion] = useState("…");
  const [state, setState] = useState<"idle" | "checking" | "current" | "found">("idle");
  const [found, setFound] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(lastCheckedAt());

  useEffect(() => {
    void currentVersion().then(setVersion);
  }, []);

  const check = () => {
    setState("checking");
    // A version found here starts downloading at once; the title bar offers the restart when
    // the bytes are ready, and the next start installs it anyway.
    void checkForUpdate().then((info) => {
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

  const note =
    state === "checking"
      ? "Checking…"
      : state === "current"
        ? "Up to date"
        : state === "found"
          ? `Version ${found} is downloading. The title bar offers the restart.`
          : checkedAt
            ? `Checked ${ago(checkedAt)}`
            : undefined;

  if (channel === "google-play") {
    return (
      <Row name="Version" value={`HProxy ${version}`} info="Google Play keeps HProxy up to date, and installs a new version before HProxy opens.">
        <Button variant="text" onClick={() => void openStorePage(GOOGLE_PLAY_URL)}>
          Google Play
        </Button>
      </Row>
    );
  }

  if (channel === "microsoft-store") {
    return (
      <Row name="Version" value={`HProxy ${version}`} info="The Microsoft Store keeps HProxy up to date. HProxy asks it for a new version before it opens.">
        <Button variant="text" onClick={() => void openStorePage(MICROSOFT_STORE_URL)}>
          Microsoft Store
        </Button>
      </Row>
    );
  }

  if (channel === "apk" || channel === "linux-deb" || channel === "linux-rpm") {
    return (
      <Row
        name="Version"
        value={`HProxy ${version}`}
        info={`A new version is offered when HProxy opens. The download installs over this ${channel === "apk" ? "one" : "package"} and keeps your saved proxies.`}
      >
        <Button variant="text" onClick={() => void openManualDownload()}>
          Download
        </Button>
      </Row>
    );
  }

  if (channel && !updatesItself(channel)) {
    return <Row name="Version" value={`HProxy ${version}`} info="The App Store keeps HProxy up to date." />;
  }

  return (
    <Row
      name="Updates"
      value={`HProxy ${version}`}
      note={note}
      info={
        <>
          <p>Updates come from hproxy.com. One installs only when it carries HProxy&rsquo;s signature and is newer than yours.</p>
          <p>
            A new version installs when HProxy starts. While you use it, it waits for your click; while nobody does (in the tray, nothing
            connected, no check running), it installs by itself and HProxy comes back in the tray. An AI agent using HProxy keeps working
            through it.
          </p>
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button disabled={state === "checking"} onClick={check}>
          Check for updates
        </Button>
        <Button variant="text" onClick={() => void openManualDownload()}>
          Download
        </Button>
      </div>
    </Row>
  );
}

/* Fraud scores, from one service or several at once, changed any time: every
   service is a tick box, several can be on, and one always is. A service that needs a key shows its field once it
   is on; its test asks once, past the session's saved scores, so a new key is
   really tried. Keys stay on this computer. */
function FraudRow({ settings, update }: { settings: SettingsType; update: (patch: Partial<SettingsType>) => void }) {
  const on = settings.fraudServices;
  const turn = (id: FraudService["id"], v: boolean) =>
    update({ fraudServices: fraudServicesOf(v ? [...on, id] : on.filter((x) => x !== id)) });
  return (
    <Row
      name="Fraud score"
      stacked
      info={
        <>
          <p>
            How risky sites may think an address is, from 0 to 100. <b>Lower is better.</b>
          </p>
          <p>
            Asked from {thisDevice()} straight to each service you tick: only the address being scored goes there, nothing goes through
            HProxy, and your keys stay on {thisDevice()}. In the Checker, the scores come when you ask for them; on Connect, for the address
            you appear as.
          </p>
          <p>With several ticked, the highest score shows, and its &ldquo;i&rdquo; names what each one said.</p>
        </>
      }
    >
      <div className="ux-services">
        {FRAUD_SERVICES.map((s) => (
          <ServiceLine
            key={s.id}
            service={s}
            on={on.includes(s.id)}
            last={on.length === 1 && on[0] === s.id}
            keys={settings.fraudKeys}
            onTurn={(v) => turn(s.id, v)}
            onKey={(k) => update({ fraudKeys: { ...settings.fraudKeys, [s.id]: k } })}
          />
        ))}
      </div>
      <div className="mt-4">
        <Check on={settings.fraudOnConnect} onChange={(fraudOnConnect) => update({ fraudOnConnect })} label="Show it while connected" />
      </div>
    </Row>
  );
}

/** One fraud-score service: its tick, its key once it is on, its test. */
function ServiceLine({
  service,
  on,
  last,
  keys,
  onTurn,
  onKey,
}: {
  service: FraudService;
  on: boolean;
  last: boolean;
  keys: FraudKeys;
  onTurn: (on: boolean) => void;
  onKey: (key: string) => void;
}) {
  const [test, setTest] = useState<{ busy: boolean; ok: boolean; text: string } | null>(null);
  const key = service.key ? (keys[service.id as keyof FraudKeys] ?? "") : "";
  useEffect(() => setTest(null), [on, key]);
  const runTest = () => {
    if (missingKey(service.id, keys)) {
      setTest({ busy: false, ok: false, text: "Add your key first" });
      return;
    }
    setTest({ busy: true, ok: false, text: "" });
    void testFraudService(service.id, keys).then((r) => setTest({ busy: false, ok: r.ok, text: r.ok ? "Works" : r.text }));
  };
  return (
    <div className="ux-service" data-on={on || undefined}>
      <span className="pick">
        <Check on={on} onChange={onTurn} label={service.name} disabled={last} title={last ? "One service stays on" : undefined} />
        {!service.key && <Tag tone="ok">Free</Tag>}
        {service.key?.optional && !on && <Tag>Key optional</Tag>}
      </span>
      {on && (
        <span className="setup">
          {service.key && (
            <span className="key">
              <Input type="password" value={key} onChange={onKey} placeholder={service.key.placeholder} mono label={`${service.name} ${service.key.label}`} />
            </span>
          )}
          <Button size="sm" variant="text" onClick={runTest} disabled={test?.busy}>
            {test?.busy ? "Asking…" : "Test"}
          </Button>
          {test && !test.busy && (
            <span className={cx("result", test.ok ? "text-ok" : "text-danger")} title={test.text}>
              {test.text}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/* The computer's time zone matched to the exit while connected
   (src-tauri/src/timezone.rs). Windows only: elsewhere there is no row, and
   the privacy check on Connect advises instead. */
function TimeZoneRow({ on, setOn }: { on: boolean; setOn: (v: boolean) => void }) {
  const [zone, setZone] = useState<ZoneStatus | null>(null);
  useEffect(() => {
    void zoneStatus()
      .then(setZone)
      .catch(() => {});
  }, []);
  if (!zone?.supported) return null;
  return (
    <Row
      name="Time zone"
      note={on && zone.automatic ? <span className="text-warn">Windows sets its own time zone. Turn that off for this to hold.</span> : undefined}
      info={
        <>
          <p>Sites compare your computer&rsquo;s time zone with the address you appear as.</p>
          <p>
            With this on, Windows takes the exit&rsquo;s time zone while you are connected. Yours comes back when you disconnect or quit, or
            at the next start if HProxy was closed some other way. Every program on this computer sees the change, not only browsers.
          </p>
        </>
      }
    >
      <div className="flex flex-col items-end gap-2">
        <Check on={on} onChange={setOn} label="Match the exit's" />
        {on && zone.automatic && (
          <Button variant="text" onClick={() => void openExternal(DATE_TIME_SETTINGS)}>
            Date and time settings
          </Button>
        )}
      </div>
    </Row>
  );
}

/* In the background, with no taskbar button. Closing the window hides
   it to the icon by the clock; starting with the computer is the person's
   choice and off until ticked. */
function BackgroundRow({ keepRunning, setKeepRunning }: { keepRunning: boolean; setKeepRunning: (v: boolean) => void }) {
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
    <Row
      name="In the background"
      note={problem ? <span className="text-danger">{problem}</span> : undefined}
      info={
        <>
          <p>Closing the window keeps HProxy running by the clock, connection and all, with no taskbar button.</p>
          <p>
            Click the icon to open it again; right-click it to connect, disconnect or quit.{" "}
            {store ? "The Microsoft Store brings the updates." : "Updates install on their own while nobody is using it."}
          </p>
        </>
      }
    >
      <div className="flex flex-col items-start gap-3">
        <Check on={keepRunning} onChange={setKeepRunning} label="Keep running when closed" />
        {!store && <Check on={withComputer} onChange={toggleWithComputer} label="Start with the computer" />}
      </div>
    </Row>
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
  const device = thisDevice();
  // The Connect page's layout, the H and the connected look: chosen once, so
  // they wait under "More looks", keeping the choices on screen few. Open by
  // itself when one of them is not the default, so a choice is never hidden.
  const [moreLooks, setMoreLooks] = useState(
    () => settings.connectDesign !== CONNECT_DESIGNS[0][0] || settings.hubStyle !== HUB_STYLES[0][0] || settings.connectLook !== CONNECT_LOOKS[0][0],
  );

  const phone = isMobile();
  // A phone opens on the list of sections; a computer on the one open last.
  const [section, setSection] = useState<SectionId | null>(() => (phone ? null : loadSection()));
  const open = (id: SectionId) => {
    if (phone) {
      pushPage(() => setSection(id));
      return;
    }
    setSection(id);
    try {
      localStorage.setItem(SECTION_KEY, id);
    } catch {
      /* not kept: fine */
    }
  };
  const here = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  usePhoneSub(phone && section ? { title: here.name, back: () => setSection(null) } : null);

  // A computer: the section list's blue pill slides to the one opened, and the section
  // comes in from below or above as the list runs (ui/slidingPill.ts, lib/motion.ts).
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLElement>(null);
  useSlidingPill(navRef, pillRef, "[aria-current='page']", section);
  const paneRef = useRef<HTMLElement>(null);
  const shownSection = useRef(section);
  useLayoutEffect(() => {
    const from = shownSection.current;
    shownSection.current = section;
    if (phone || !from || !section || from === section) return;
    const at = (id: SectionId) => SECTIONS.findIndex((s) => s.id === id);
    slideIn(paneRef.current, at(section) > at(from) ? "down" : "up");
  }, [section, phone]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-6 pb-8 pt-1.5 max-sm:px-3">
        <Card tone="flat" pad="roomy">
          {/* On a phone the top bar names the page. */}
          {!phone && <PageHead title="Settings" />}

          {phone && section === null ? (
            <nav className="ux-setlist" aria-label="Settings sections">
              {SECTIONS.map((s) => (
                <button key={s.id} type="button" className="ux-setlink" onClick={() => open(s.id)}>
                  <span className="icon">
                    <s.icon />
                  </span>
                  <span className="name">{s.name}</span>
                  <Icon.chevronRight className="go" />
                </button>
              ))}
            </nav>
          ) : (
            <div className="ux-settings">
              {!phone && (
                <nav ref={navRef} className="ux-setnav" aria-label="Settings sections">
                  <i ref={pillRef} className="ux-pill" aria-hidden="true" />
                  {SECTIONS.map((s) => (
                    <button key={s.id} type="button" aria-current={s.id === section ? "page" : undefined} onClick={() => open(s.id)}>
                      <s.icon />
                      {s.name}
                    </button>
                  ))}
                </nav>
              )}

              <section ref={paneRef} className="ux-setpane" aria-label={here.name}>
                {section === "checking" && (
                  <>
                    <Row
                      name="Checks at once"
                      value={highConcurrency ? <span className="text-danger">{settings.concurrency}</span> : settings.concurrency}
                      note={
                        highConcurrency ? (
                          <span className="text-danger">Above {GENTLE_CONCURRENCY_CEILING}, a home router can drop for a moment.</span>
                        ) : undefined
                      }
                      info={
                        <>
                          <p>How many proxies are checked at the same time. More is quicker.</p>
                          <p>
                            Above {GENTLE_CONCURRENCY_CEILING}, a home router can be overwhelmed and your internet can drop for a moment: for strong
                            connections only. A ceiling, not a target: HProxy backs off when your line queues.
                          </p>
                        </>
                      }
                    >
                      <Range
                        value={settings.concurrency}
                        onChange={(v) => update({ concurrency: v })}
                        min={1}
                        max={MAX_CONCURRENCY}
                        label="Checks at once"
                        danger={highConcurrency}
                      />
                    </Row>

                    <Row name="Wait per proxy" value={`${seconds} s`} info="How long to wait for a proxy to answer before it counts as not answering.">
                      <Range value={seconds} onChange={(v) => update({ timeoutMs: Math.max(1000, v * 1000) })} min={1} max={60} label="Wait per proxy, in seconds" />
                    </Row>

                    <Row
                      name="Protocols"
                      info={
                        <>
                          <dl>
                            <dt>HTTP, HTTPS</dt>
                            <dd>Web proxies, for browsers and most programs.</dd>
                            <dt>SOCKS4, SOCKS5</dt>
                            <dd>Carry any program&rsquo;s traffic. SOCKS5 also takes a login.</dd>
                          </dl>
                          <p>Only the ticked ones are tried. Fewer means fewer connections per proxy.</p>
                        </>
                      }
                    >
                      <div className="ux-ticks">
                        {(Object.keys(PROTOCOL_LABEL) as (keyof Protocols)[]).map((k) => (
                          <Check key={k} on={settings.protocols[k]} onChange={(v) => toggleProto(k, v)} label={PROTOCOL_LABEL[k]} />
                        ))}
                      </div>
                    </Row>

                    <Row name="Retries" info="How many more times to try a proxy that did not answer.">
                      <ButtonGroup
                        size="sm"
                        value={String(settings.retries)}
                        onChange={(v) => update({ retries: Number(v) })}
                        options={
                          [
                            ["0", "None"],
                            ["1", "1"],
                            ["2", "2"],
                            ["3", "3"],
                          ] as const
                        }
                      />
                    </Row>

                    <Row
                      name="Check from"
                      note={settings.source !== "local" ? <span className="text-warn">Your list, logins included, goes to HProxy&rsquo;s servers.</span> : undefined}
                      /* Stated where the choice is made, not in a help page nobody
                         opens. Every mode that touches our servers sends credentials
                         with the list. Keep this, settings.ts and the README's "What
                         leaves your machine" table saying the same thing. */
                      info={
                        <>
                          <dl>
                            <dt>{thisDevice(true)}</dt>
                            <dd>The default. Nothing about your proxies is sent, and every detail is measured. A big list is many connections from your address.</dd>
                            <dt>Both</dt>
                            <dd>The fastest. Our servers and {device} share the list: part of it, logins included, is sent to us.</dd>
                            <dt>HProxy&rsquo;s servers</dt>
                            <dd>Your address never touches the proxies. Your whole list, logins included, is sent to us, and fewer details come back.</dd>
                          </dl>
                          <p>Proxies locked to your own IP address fail from our servers.</p>
                        </>
                      }
                    >
                      {/* Default first: the order of a set of choices reads as a recommendation. */}
                      <ButtonGroup
                        size="sm"
                        value={settings.source}
                        onChange={(source) => update({ source })}
                        options={
                          [
                            ["local", thisDevice(true)],
                            ["both", "Both"],
                            ["api", "HProxy's servers"],
                          ] as const
                        }
                      />
                    </Row>

                    <Row
                      name="Country and network"
                      /* ⚠️ The second half is derived from the mode above rather than
                         asserted: a privacy claim that quietly goes stale is worse than
                         no claim. */
                      info={
                        <>
                          <p>Shows each proxy&rsquo;s country, city and provider.</p>
                          <p>
                            The addresses you check go to HProxy&rsquo;s free IP lookup in batches. Never the ports, the logins or the results.{" "}
                            {settings.source === "local"
                              ? `Checking runs entirely on ${device}, so with this off the app sends nothing at all.`
                              : "Checking also runs on our servers, so part of your list reaches us either way."}
                          </p>
                        </>
                      }
                    >
                      <Check on={settings.geoLookup} onChange={(v) => update({ geoLookup: v })} label="Look up" />
                    </Row>

                    <Row
                      name="Extra tests"
                      info={
                        <>
                          <p>Each costs one more round trip per working proxy, and shows in the proxy&rsquo;s details.</p>
                          <dl>
                            <dt>UDP</dt>
                            <dd>Whether a SOCKS5 proxy carries UDP, which games, calls and DNS use.</dd>
                            <dt>Speed</dt>
                            <dd>Pulls a small file through the proxy and shows Mbit/s.</dd>
                          </dl>
                        </>
                      }
                    >
                      <div className="flex flex-col items-start gap-3">
                        <Check on={settings.measureUdp} onChange={(v) => update({ measureUdp: v })} label="UDP on SOCKS5" />
                        <Check on={settings.measureSpeed} onChange={(v) => update({ measureSpeed: v })} label="Download speed" />
                      </div>
                    </Row>
                  </>
                )}

                {section === "connect" && (
                  <>
                    <Row
                      name="Connection check"
                      value={probePreset ? undefined : "custom"}
                      info={
                        <>
                          <p>Every twenty seconds while connected, one request goes through the proxy to see that it still works.</p>
                          <dl>
                            {PROBE_PRESETS.map(([url, name, what]) => (
                              <div key={url} className="contents">
                                <dt>{name}</dt>
                                <dd>{what}</dd>
                              </div>
                            ))}
                            <dt>Custom</dt>
                            <dd>any http or https address; empty means HProxy</dd>
                          </dl>
                        </>
                      }
                    >
                      <div className="flex flex-wrap items-center justify-end gap-3">
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
                            label="Check address"
                          />
                        )}
                      </div>
                    </Row>

                    <TimeZoneRow on={settings.matchTimeZone} setOn={(matchTimeZone) => update({ matchTimeZone })} />

                    <FraudRow settings={settings} update={update} />
                  </>
                )}

                {section === "look" && (
                  <>
                    <Row name="White or dark">
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
                    </Row>

                    <Row name="Background" stacked info={`Each picture is the real page, small. Your own picture stays on ${device} and is never sent anywhere.`}>
                      <BackgroundPicker value={settings.background} onChange={(background) => update({ background })} />
                    </Row>

                    <div className="ux-setmore">
                      <button type="button" className="ux-link" aria-expanded={moreLooks} onClick={() => setMoreLooks(!moreLooks)}>
                        More looks
                        <Icon.chevronDown className={cx("h-3.5 w-3.5 transition-transform", moreLooks && "rotate-180")} />
                      </button>
                    </div>

                    {moreLooks && (
                      <>
                        <Row
                          name="Connect page"
                          stacked
                          info={
                            <dl>
                              {CONNECT_DESIGNS.map(([d, name, what]) => (
                                <div key={d} className="contents">
                                  <dt>{name}</dt>
                                  <dd>{what}</dd>
                                </div>
                              ))}
                            </dl>
                          }
                        >
                          <ButtonGroup
                            size="sm"
                            value={settings.connectDesign}
                            onChange={(connectDesign) => update({ connectDesign })}
                            options={CONNECT_DESIGNS.map(([d, name]) => [d, name] as const)}
                          />
                        </Row>

                        <Row
                          name="The H"
                          stacked
                          info={
                            <dl>
                              {HUB_STYLES.map(([h, name, what]) => (
                                <div key={h} className="contents">
                                  <dt>{name}</dt>
                                  <dd>{what}</dd>
                                </div>
                              ))}
                            </dl>
                          }
                        >
                          <ButtonGroup
                            size="sm"
                            value={settings.hubStyle}
                            onChange={(hubStyle) => update({ hubStyle })}
                            options={HUB_STYLES.map(([h, name]) => [h, name] as const)}
                          />
                        </Row>

                        <Row
                          name="When connected"
                          stacked
                          info={
                            <dl>
                              {CONNECT_LOOKS.map(([l, name, what]) => (
                                <div key={l} className="contents">
                                  <dt>{name}</dt>
                                  <dd>{what}</dd>
                                </div>
                              ))}
                            </dl>
                          }
                        >
                          <ButtonGroup
                            size="sm"
                            value={settings.connectLook}
                            onChange={(connectLook) => update({ connectLook })}
                            options={CONNECT_LOOKS.map(([l, name]) => [l, name] as const)}
                          />
                        </Row>
                      </>
                    )}
                  </>
                )}

                {section === "app" && (
                  <>
                    {!isMobile() && <BackgroundRow keepRunning={settings.keepRunning} setKeepRunning={(keepRunning) => update({ keepRunning })} />}
                    <UpdatesRow />
                    <Row
                      name="Privacy"
                      info="Every server HProxy talks to, what each one receives, what our servers keep and for how long, and how to have it deleted."
                    >
                      <Button variant="text" onClick={() => void openExternal(PRIVACY_POLICY_URL)}>
                        Privacy policy
                      </Button>
                    </Row>
                  </>
                )}
              </section>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
