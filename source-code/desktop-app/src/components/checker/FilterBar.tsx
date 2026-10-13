/* The filters: what narrows the list (2026-10-12: no grey boxes, less text,
 * more compact). One Filters button beside the search opens every group in one
 * panel; what is on shows under the toolbar as small chips, each with its ×,
 * then Reset and how many rows show. Which proxies show at all (working, not
 * working, all) is the status line above the toolbar (CheckerConsole.tsx),
 * no longer a tick called "Show dead".
 *
 *   [Search …………………]  Filters 2 ▾      Fraud scores   Export ▾   New list   [Copy 4 working]
 *   HTTPS, SOCKS5 ×   DE, US ×   Reset   3 shown
 *
 * Before: five buttons in a row (Protocol, Anonymity, Country, Latency, More;
 * 2026-10-10), and before that a panel standing open on half the window.
 * Every filter of both is still here: the ticks with their counts, every
 * country on the list with a search, the latency slider, keep-alive and
 * rotating only, the ports with Allow or Block. The words are the ones proxy
 * people already know. */

import { useState, type Dispatch, type SetStateAction } from "react";
import { BlockTitle, ButtonGroup, Check, Chip, Icon, Input, Popover, Range } from "../ui";

export const PROTOS = ["http", "https", "socks4", "socks5"] as const;
export const ANONS = ["Elite", "Anonymous", "Transparent"] as const;
/** Slider top = off, i.e. show every latency. */
export const LATENCY_MAX = 20000;

/** Which proxies show: the ones that work (the default), the ones that do not, or all. */
export type Status = "working" | "failed" | "all";

export type Filters = {
  search: string;
  proto: Record<string, boolean>;
  anon: Record<string, boolean>;
  status: Status;
  onlyKeepAlive: boolean;
  onlyRotating: boolean;
  maxLatency: number;
  /** Comma-separated port list, and whether it allows or blocks them. */
  ports: string;
  portsAllow: boolean;
  /** Selected country codes. Empty means every country. */
  countries: string[];
};

export const EMPTY_FILTERS: Filters = {
  search: "",
  proto: { http: true, https: true, socks4: true, socks5: true },
  anon: { Elite: true, Anonymous: true, Transparent: true },
  status: "working",
  onlyKeepAlive: false,
  onlyRotating: false,
  maxLatency: LATENCY_MAX,
  ports: "",
  portsAllow: true,
  countries: [],
};

/* What the words mean: the words stay the ones proxy people know, and the
   "i" beside each group says them plainly. */
export const ANONYMITY_INFO = (
  <dl>
    <dt>Elite</dt>
    <dd>Sites see neither your address nor that you use a proxy.</dd>
    <dt>Anonymous</dt>
    <dd>Sites can tell it is a proxy, but not your address.</dd>
    <dt>Transparent</dt>
    <dd>Passes your real address on: it hides nothing.</dd>
  </dl>
);

export const PROTOCOL_INFO = (
  <dl>
    <dt>HTTP, HTTPS</dt>
    <dd>Web proxies, for browsers and most programs.</dd>
    <dt>SOCKS4, SOCKS5</dt>
    <dd>Carry any program&rsquo;s traffic. SOCKS5 also takes a login.</dd>
  </dl>
);

export const KEEP_ALIVE_INFO = "Keeps one connection open for many requests, which makes browsing and scraping faster.";

export const LATENCY_INFO = "How long the proxy took to answer, in milliseconds. Lower is faster.";

export const PROTO_LABEL: Record<(typeof PROTOS)[number], string> = {
  http: "HTTP",
  https: "HTTPS",
  socks4: "SOCKS4",
  socks5: "SOCKS5",
};

const spaced = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

/** The picked ones in words, or "None" when every tick is off; nothing when all are on. */
function picked(all: readonly string[], on: Record<string, boolean>, word: (k: string) => string): string | undefined {
  const keep = all.filter((k) => on[k]);
  if (keep.length === all.length) return undefined;
  return keep.length ? keep.map(word).join(", ") : "None";
}

/** What narrows the list, each as a chip's words and how to take it off.
    The search and which proxies show are not here: each says itself where it is. */
function narrowing(filters: Filters, setFilters: Dispatch<SetStateAction<Filters>>): { key: string; words: string; clear: () => void }[] {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const proto = picked(PROTOS, filters.proto, (p) => PROTO_LABEL[p as (typeof PROTOS)[number]]);
  const anon = picked(ANONS, filters.anon, (a) => a);
  const out: { key: string; words: string; clear: () => void }[] = [];
  if (proto) out.push({ key: "proto", words: proto === "None" ? "No protocol" : proto, clear: () => set("proto", EMPTY_FILTERS.proto) });
  if (anon) out.push({ key: "anon", words: anon === "None" ? "No grade" : anon, clear: () => set("anon", EMPTY_FILTERS.anon) });
  if (filters.countries.length) {
    const words = filters.countries.length <= 3 ? filters.countries.map((c) => c.toUpperCase()).join(", ") : `${filters.countries.length} countries`;
    out.push({ key: "countries", words, clear: () => set("countries", []) });
  }
  if (filters.maxLatency < LATENCY_MAX) out.push({ key: "latency", words: `Under ${spaced(filters.maxLatency)} ms`, clear: () => set("maxLatency", LATENCY_MAX) });
  if (filters.onlyKeepAlive) out.push({ key: "keepalive", words: "Keep-alive only", clear: () => set("onlyKeepAlive", false) });
  if (filters.onlyRotating) out.push({ key: "rotating", words: "Rotating only", clear: () => set("onlyRotating", false) });
  if (filters.ports.trim()) {
    out.push({ key: "ports", words: `${filters.portsAllow ? "Ports" : "Not ports"} ${filters.ports.trim()}`, clear: () => set("ports", "") });
  }
  return out;
}

/** How many filters narrow the list (the badge on the Filters button). */
export function activeFilterCount(filters: Filters): number {
  return narrowing(filters, () => {}).length;
}

export type FilterButtonProps = {
  filters: Filters;
  setFilters: Dispatch<SetStateAction<Filters>>;
  /** How many working rows carry each protocol and grade, shown beside the ticks. */
  counts: { proto: Record<string, number>; anon: Record<string, number> };
  /** Every country on the list, most rows first. */
  countries: { cc: string; count: number; name?: string }[];
};

/** A list long enough to want its own search above the chips. */
const COUNTRY_SEARCH_FROM = 16;

/** The one Filters button and its panel, every group in it. */
export function FilterButton({ filters, setFilters, counts, countries }: FilterButtonProps) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const toggleIn = (k: "proto" | "anon", key: string) => setFilters((f) => ({ ...f, [k]: { ...f[k], [key]: !f[k][key] } }));
  const toggleCountry = (cc: string) =>
    setFilters((f) => ({
      ...f,
      countries: f.countries.includes(cc) ? f.countries.filter((c) => c !== cc) : [...f.countries, cc],
    }));

  const [countryQuery, setCountryQuery] = useState("");
  const q = countryQuery.trim().toLowerCase();
  const countriesShown = q ? countries.filter(({ cc, name }) => cc.includes(q) || (name ?? "").toLowerCase().includes(q)) : countries;
  const active = activeFilterCount(filters);

  return (
    <Popover label="Filters" icon={<Icon.filter className="h-4 w-4" />} count={active} on={active > 0} wide>
      <div className="ux-filtergrid">
        <section>
          <BlockTitle name="Protocol" info={PROTOCOL_INFO} />
          <div className="ux-popchecks">
            {PROTOS.map((p) => (
              <Check key={p} on={filters.proto[p]} onChange={() => toggleIn("proto", p)} label={PROTO_LABEL[p]} count={spaced(counts.proto[p] ?? 0)} />
            ))}
          </div>
        </section>
        <section>
          <BlockTitle name="Anonymity" info={ANONYMITY_INFO} />
          <div className="ux-popchecks">
            {ANONS.map((a) => (
              <Check key={a} on={filters.anon[a]} onChange={() => toggleIn("anon", a)} label={a} count={spaced(counts.anon[a] ?? 0)} />
            ))}
          </div>
        </section>
      </div>

      <div className="ux-popgroup">
        <BlockTitle
          name="Countries"
          value={filters.countries.length ? `${spaced(filters.countries.length)} picked` : `${spaced(countries.length)} on the list`}
          aside={
            filters.countries.length > 0 && (
              <button type="button" className="ux-link" onClick={() => set("countries", [])}>
                Every country
              </button>
            )
          }
        />
        {countries.length >= COUNTRY_SEARCH_FROM && (
          <Input icon="search" value={countryQuery} onChange={setCountryQuery} placeholder="Find a country" label="Find a country" />
        )}
        <div className="ux-popchips">
          {countriesShown.length === 0 ? (
            <p className="ux-popquiet">{countries.length === 0 ? "No country known yet." : "No country by that name on the list."}</p>
          ) : (
            countriesShown.map(({ cc, count, name }) => (
              <Chip key={cc} on={filters.countries.includes(cc)} onClick={() => toggleCountry(cc)} title={name}>
                <span className={`fi fi-${cc}`} />
                {cc.toUpperCase()}
                <span className="n num">{spaced(count)}</span>
              </Chip>
            ))
          )}
        </div>
      </div>

      <div className="ux-popgroup">
        <BlockTitle
          name="Max latency"
          info={<>Hides the proxies slower than this. {LATENCY_INFO}</>}
          value={filters.maxLatency >= LATENCY_MAX ? "No limit" : `${spaced(filters.maxLatency)} ms`}
        />
        <div className="ux-poprange">
          <Range value={filters.maxLatency} onChange={(v) => set("maxLatency", v)} min={200} max={LATENCY_MAX} step={100} label="Max latency" />
        </div>
      </div>

      <div className="ux-popgroup ux-filtergrid">
        <section>
          <BlockTitle
            name="Only"
            info={
              <dl>
                <dt>Keep-alive</dt>
                <dd>{KEEP_ALIVE_INFO}</dd>
                <dt>Rotating</dt>
                <dd>Traffic comes out of another address than the one you dialled: a rotating gateway or a pool.</dd>
              </dl>
            }
          />
          <div className="ux-popchecks">
            <Check on={filters.onlyKeepAlive} onChange={(v) => set("onlyKeepAlive", v)} label="Keep-alive" />
            {/* Ours, not theirs: "only the ones that came out somewhere
                else" is the question the exit address exists to answer. */}
            <Check on={filters.onlyRotating} onChange={(v) => set("onlyRotating", v)} label="Rotating" />
          </div>
        </section>
        {/* Allow or block the same list: "only 8080" and "anything but 8080"
            are the two questions people have, and one field answers both. */}
        <section>
          <BlockTitle name="Ports" info="Allow keeps only these ports; Block hides them. Separate them with commas." />
          <div className="flex flex-col gap-2">
            <Input value={filters.ports} onChange={(v) => set("ports", v)} placeholder="8080, 80, 3128" label="Ports" mono />
            <ButtonGroup
              size="sm"
              value={filters.portsAllow ? "allow" : "block"}
              onChange={(v) => set("portsAllow", v === "allow")}
              options={
                [
                  ["allow", "Allow"],
                  ["block", "Block"],
                ] as const
              }
            />
          </div>
        </section>
      </div>
    </Popover>
  );
}

/** What narrows the list, under the toolbar: a chip per filter with its ×, Reset, and how many show.
    Nothing while no filter is on. */
export function ActiveFilters({ filters, setFilters, shown }: { filters: Filters; setFilters: Dispatch<SetStateAction<Filters>>; shown: number }) {
  const chips = narrowing(filters, setFilters);
  if (chips.length === 0) return null;
  return (
    <div className="ux-activefilters">
      {chips.map((c) => (
        <button key={c.key} type="button" className="ux-filterchip" onClick={c.clear} title={`Stop filtering: ${c.words}`}>
          {c.words}
          <Icon.cross className="h-3 w-3" />
        </button>
      ))}
      <button type="button" className="ux-link" onClick={() => setFilters((f) => ({ ...EMPTY_FILTERS, search: f.search, status: f.status }))}>
        Reset
      </button>
      <span className="shown num">
        <b>{spaced(shown)}</b> shown
      </span>
    </div>
  );
}
