/* The filters: what narrows the list, in look D (2026-09-23).
 *
 * Laid out the way the old screen had them, which read simpler: two
 * columns of groups (Anonymity | Protocols, then Extras | Max latency), the
 * ports with Allow or Block, and a last line with the countries and how many
 * rows are showing. The words are the ones proxy people already know. What is
 * ours is the look: tick boxes with the H's corners whose tick draws itself,
 * plain group titles in our blue, our tabs for Allow / Block, the switch's cut
 * knob on the slider, "Showing 4 of 10" where unfx has two counter pills.
 *
 * "Hide filters" folds the groups and the ports away; the countries line
 * stays, so the one filter people use most is never more than a click. */

import type { Dispatch, SetStateAction } from "react";
import { BlockTitle, ButtonGroup, Check, Chip, Input, Range, cx } from "../ui";

export const PROTOS = ["http", "https", "socks4", "socks5"] as const;
export const ANONS = ["Elite", "Anonymous", "Transparent"] as const;
/** Slider top = off, i.e. show every latency. */
export const LATENCY_MAX = 20000;

export type Filters = {
  search: string;
  proto: Record<string, boolean>;
  anon: Record<string, boolean>;
  showDead: boolean;
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
  showDead: false,
  onlyKeepAlive: false,
  onlyRotating: false,
  maxLatency: LATENCY_MAX,
  ports: "",
  portsAllow: true,
  countries: [],
};

export const PROTO_LABEL: Record<(typeof PROTOS)[number], string> = {
  http: "HTTP",
  https: "HTTPS",
  socks4: "SOCKS4",
  socks5: "SOCKS5",
};

const spaced = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

export type FilterPanelProps = {
  filters: Filters;
  setFilters: Dispatch<SetStateAction<Filters>>;
  /** How many working rows carry each protocol and grade, shown beside the ticks. */
  counts: { proto: Record<string, number>; anon: Record<string, number> };
  /** The countries on the list, most rows first. */
  countries: { cc: string; count: number; name?: string }[];
  /** "Showing X of Y". */
  showing: number;
  total: number;
  /** Whether the groups are unfolded, and how many groups are narrowing the list. */
  open: boolean;
  onToggleOpen: () => void;
  activeCount: number;
};

export function FilterPanel({ filters, setFilters, counts, countries, showing, total, open, onToggleOpen, activeCount }: FilterPanelProps) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const toggleIn = (k: "proto" | "anon", key: string) =>
    setFilters((f) => ({ ...f, [k]: { ...f[k], [key]: !f[k][key] } }));
  const toggleCountry = (cc: string) =>
    setFilters((f) => ({
      ...f,
      countries: f.countries.includes(cc) ? f.countries.filter((c) => c !== cc) : [...f.countries, cc],
    }));

  return (
    <div className="ux-filters">
      <div className="collapsible" data-open={open}>
        <div>
          <div className="ux-groups">
            <div className="ux-group">
              <BlockTitle name="Anonymity" />
              <div className="ux-checks">
                {ANONS.map((a) => (
                  <Check key={a} on={filters.anon[a]} onChange={() => toggleIn("anon", a)} label={a} count={spaced(counts.anon[a] ?? 0)} />
                ))}
              </div>
            </div>

            <div className="ux-group">
              <BlockTitle name="Protocols" />
              <div className="ux-checks">
                {PROTOS.map((p) => (
                  <Check key={p} on={filters.proto[p]} onChange={() => toggleIn("proto", p)} label={PROTO_LABEL[p]} count={spaced(counts.proto[p] ?? 0)} />
                ))}
              </div>
            </div>

            <div className="ux-group">
              <BlockTitle name="Extras" />
              <div className="ux-checks">
                <Check on={filters.onlyKeepAlive} onChange={(v) => set("onlyKeepAlive", v)} label="Keep-alive only" />
                {/* Ours, not theirs: "only the ones that came out somewhere
                    else" is the question the exit address exists to answer. */}
                <Check on={filters.onlyRotating} onChange={(v) => set("onlyRotating", v)} label="Rotating only" />
                <Check on={filters.showDead} onChange={(v) => set("showDead", v)} label="Show dead" />
              </div>
            </div>

            <div className="ux-group">
              <BlockTitle name="Max latency" value={filters.maxLatency >= LATENCY_MAX ? "No limit" : `${spaced(filters.maxLatency)} ms`} />
              <Range value={filters.maxLatency} onChange={(v) => set("maxLatency", v)} min={200} max={LATENCY_MAX} step={100} label="Max latency" />
            </div>
          </div>

          {/* Allow or block the same list: "only 8080" and "anything but 8080"
              are the two questions people have, and one field answers both. */}
          <div className="ux-line">
            <BlockTitle name="Ports" />
            <span className="min-w-[140px] flex-1">
              <Input value={filters.ports} onChange={(v) => set("ports", v)} placeholder="8080, 80, 3128" label="Ports" mono />
            </span>
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
        </div>
      </div>

      <div className={cx("ux-line", !open && "is-first")}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {countries.map(({ cc, count, name }) => (
            <Chip key={cc} on={filters.countries.includes(cc)} onClick={() => toggleCountry(cc)} title={name}>
              <span className={`fi fi-${cc}`} />
              {cc.toUpperCase()}
              <span className="n num">{spaced(count)}</span>
            </Chip>
          ))}
          <button type="button" className="ux-link ml-2" onClick={onToggleOpen}>
            {open ? "Hide filters" : `Show filters${activeCount ? ` (${activeCount} on)` : ""}`}
          </button>
          {activeCount > 0 && (
            <button type="button" className="ux-link ml-2" onClick={() => setFilters((f) => ({ ...EMPTY_FILTERS, search: f.search }))}>
              Reset
            </button>
          )}
        </div>
        <span className="ux-showing num">
          Showing <b>{spaced(showing)}</b> of <b>{spaced(total)}</b>
        </span>
      </div>
    </div>
  );
}
