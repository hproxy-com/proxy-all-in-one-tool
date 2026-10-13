/* The dot map of the Mix page: the phone app's map (phone-android/.../ui/map/World.kt and
   DotMap.kt), which began as the design lab's mapCanvas.ts.

   · The land is every country's real outline (world-land.json, Natural Earth) in Web
     Mercator, so a close-up is never stretched and moving the camera is a plain move and zoom.
   · The dots are a grid fixed to the ground: going in, the grid splits in two again and again
     and the new dots grow out of nothing between the old ones.
   · A flight follows van Wijk and Nuij's zoom-and-pan path ("Smooth and efficient zooming and
     panning", 2003): from one city to another it rises, crosses and comes down. A new place
     while flying bends the flight at the camera's own speed, it never brakes first.
   · A lit country hands over to the next one: the old one fades out while the new one fades in,
     in a few steps of solid colours.
   · Close up, the borders are drawn (dots alone left Europe unreadable): the lit
     country's in white, the others' as thin light lines. From a country's closeness on, the
     land and the lit country are read from Natural Earth's 1:50m borders (world-borders.json,
     loaded once while the page rests), so the dots and the lines agree.

   Every dot and line is a solid colour (house rule: nothing see-through). */

import LAND from "./world-land.json";

/** A camera over the world: its centre in Mercator degrees (x the longitude, y the stretched
    latitude) and its scale in CSS pixels per degree. */
export type Cam = { x: number; y: number; s: number };

const RAD = Math.PI / 180;

/** A latitude as Web Mercator's y, in degrees. The map stops at ±85°. */
export function mercY(lat: number): number {
  const p = Math.max(-85, Math.min(85, lat)) * RAD;
  return Math.log(Math.tan(Math.PI / 4 + p / 2)) / RAD;
}

/** Web Mercator's y back to a latitude. */
export const latOf = (y: number) => (2 * Math.atan(Math.exp(y * RAD)) - Math.PI / 2) / RAD;

export const camOn = (lat: number, lng: number, s: number): Cam => ({ x: lng, y: mercY(lat), s });

/** The world view, a country while the app checks where you appear, and the city it dives to
    once you are on (about 270 km across a phone's screen; the same scale here). */
export const WORLD_S = 1500 / 360;
export const CITY_S = 140;

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

function quiet(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/* ---------- the land ---------- */

/** A ring in Mercator degrees, with its box; a long one also keeps its edges sorted into bands
    of latitude, so asking whether a point is inside reads one band, not the whole ring. */
type Ring = { pts: Float32Array; x0: number; y0: number; x1: number; y1: number; bands?: Int32Array[]; bandH?: number };
/** `key` tells the world view's copy of a country from its fine one (a lit country's dots are
    remembered per copy). */
export type Country = { cc: string; key: string; rings: Ring[]; x0: number; y0: number; x1: number; y1: number };

let WORLD: Country[] | null = null;
const BY_CC = new Map<string, Country>();

/** The same world at Natural Earth's 1:50m, for close-ups: asked for once, then kept. */
let FINE: Country[] | null = null;
const FINE_BY_CC = new Map<string, Country>();
let fineAsked = false;
const fineSubs = new Set<() => void>();

/** One ring from its encoded polyline: longitude, latitude, in turn, in hundredths. */
function decode(text: string): number[] {
  const out: number[] = [];
  let i = 0;
  let lng = 0;
  let lat = 0;
  while (i < text.length) {
    for (let axis = 0; axis < 2; axis++) {
      let bits = 0;
      let shift = 0;
      let b: number;
      do {
        b = text.charCodeAt(i++) - 63;
        bits |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = bits & 1 ? ~(bits >> 1) : bits >> 1;
      if (axis === 0) lng += d;
      else lat += d;
    }
    out.push(lng / 100, lat / 100);
  }
  return out;
}

function world(): Country[] {
  return (WORLD ??= build(LAND as Record<string, string[]>, BY_CC, ""));
}

/** Asks for the fine borders once (they load while the page rests, before a close-up needs
    them); every map listening draws again when they are there. */
export function loadBorders(): void {
  if (fineAsked) return;
  fineAsked = true;
  import("./world-borders.json")
    .then((m) => {
      FINE = build(m.default as Record<string, string[]>, FINE_BY_CC, "+");
      fineSubs.forEach((fn) => fn());
    })
    .catch(() => {
      fineAsked = false;
    });
}

export function onBorders(fn: () => void): () => void {
  fineSubs.add(fn);
  return () => {
    fineSubs.delete(fn);
  };
}

function build(data: Record<string, string[]>, into: Map<string, Country>, mark: string): Country[] {
  const all: Country[] = [];
  for (const [cc, list] of Object.entries(data)) {
    const c: Country = { cc: cc.toLowerCase(), key: cc.toLowerCase() + mark, rings: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const text of list) {
      const raw = decode(text);
      if (raw.length < 6) continue;
      const pts = new Float32Array(raw.length);
      const r: Ring = { pts, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let k = 0; k < raw.length; k += 2) {
        const x = raw[k];
        const y = mercY(raw[k + 1]);
        pts[k] = x;
        pts[k + 1] = y;
        r.x0 = Math.min(r.x0, x);
        r.x1 = Math.max(r.x1, x);
        r.y0 = Math.min(r.y0, y);
        r.y1 = Math.max(r.y1, y);
      }
      c.rings.push(r);
      c.x0 = Math.min(c.x0, r.x0);
      c.x1 = Math.max(c.x1, r.x1);
      c.y0 = Math.min(c.y0, r.y0);
      c.y1 = Math.max(c.y1, r.y1);
    }
    if (!c.rings.length) continue;
    all.push(c);
    into.set(c.cc, c);
  }
  return all;
}

export function countryOf(cc: string | null | undefined): Country | undefined {
  if (!cc) return undefined;
  world();
  return BY_CC.get(cc.toLowerCase());
}

/** Where the camera goes for a country before the exit's own city is known: the middle of its
    biggest piece of land, as [latitude, longitude]. */
export function centreOf(c: Country): [number, number] {
  let best: Ring | null = null;
  let bestArea = -1;
  for (const r of c.rings) {
    const a = Math.abs(ringArea(r.pts));
    if (a > bestArea) {
      bestArea = a;
      best = r;
    }
  }
  if (!best) return [0, 0];
  const p = best.pts;
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    const cross = p[i] * p[j + 1] - p[j] * p[i + 1];
    a2 += cross;
    cx += (p[i] + p[j]) * cross;
    cy += (p[i + 1] + p[j + 1]) * cross;
  }
  if (Math.abs(a2) < 1e-9) return [latOf((best.y0 + best.y1) / 2), (best.x0 + best.x1) / 2];
  return [latOf(cy / (3 * a2)), cx / (3 * a2)];
}

function ringArea(p: Float32Array): number {
  let s = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return s / 2;
}

/** How close the camera goes for a whole country: it fills most of the width. */
export function countryScale(c: Country | undefined, width: number): number {
  if (!c) return WORLD_S * 2;
  const span = Math.max(c.x1 - c.x0, c.y1 - c.y0);
  return Math.min(CITY_S / 3, Math.max(WORLD_S * 1.6, (0.7 * width) / Math.max(span, 0.5)));
}

/** Even-odd over the country's rings, so a lake or an enclave stays out. */
function insideCountry(c: Country, x: number, y: number): boolean {
  const xx = x - Math.round((x - (c.x0 + c.x1) / 2) / 360) * 360;
  if (xx < c.x0 || xx > c.x1 || y < c.y0 || y > c.y1) return false;
  let hit = false;
  for (const r of c.rings) {
    if (xx < r.x0 || xx > r.x1 || y < r.y0 || y > r.y1) continue;
    const p = r.pts;
    if (p.length > 96) {
      // A long ring (France's mainland has about 700 points): only the edges in this band.
      const bands = r.bands ?? bandsOf(r);
      const band = bands[Math.min(bands.length - 1, Math.floor((y - r.y0) / r.bandH!))];
      for (let n = 0; n < band.length; n++) {
        const a = band[n];
        const b = a === 0 ? p.length - 2 : a - 2;
        const ya = p[a + 1];
        const yb = p[b + 1];
        if (ya > y !== yb > y && xx < ((p[b] - p[a]) * (y - ya)) / (yb - ya) + p[a]) hit = !hit;
      }
      continue;
    }
    for (let a = 0, b = p.length - 2; a < p.length; b = a, a += 2) {
      const ya = p[a + 1];
      const yb = p[b + 1];
      if (ya > y !== yb > y && xx < ((p[b] - p[a]) * (y - ya)) / (yb - ya) + p[a]) hit = !hit;
    }
  }
  return hit;
}

/** Sorts a ring's edges (each from the point before to point `a`) into bands of latitude: an
    edge sits in every band it crosses, so one band holds every edge a point there can cross. */
function bandsOf(r: Ring): Int32Array[] {
  const p = r.pts;
  const n = p.length / 2;
  const count = Math.max(8, Math.min(256, Math.round(n / 6)));
  const h = (r.y1 - r.y0) / count || 1;
  const lists: number[][] = Array.from({ length: count }, () => []);
  for (let e = 0; e < n; e++) {
    const a = e * 2;
    const b = a === 0 ? p.length - 2 : a - 2;
    const lo = Math.max(0, Math.floor((Math.min(p[a + 1], p[b + 1]) - r.y0) / h));
    const hi = Math.min(count - 1, Math.floor((Math.max(p[a + 1], p[b + 1]) - r.y0) / h));
    for (let k = lo; k <= hi; k++) lists[k].push(a);
  }
  r.bandH = h;
  return (r.bands = lists.map((l) => Int32Array.from(l)));
}

/* ---------- the camera's flight ---------- */

const RHO = Math.SQRT2;

/** van Wijk and Nuij's path from a to b for a view `width` pixels wide: `at(u)` for u from 0 to
    1, and the path's length in their measure (how far it feels, zoom and pan as one). */
function zoomPath(a: Cam, b: Cam, width: number): { S: number; at: (t: number) => Cam } {
  const w0 = width / a.s;
  const w1 = width / b.s;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 < 1e-9) {
    const S = Math.log(w1 / w0) / RHO;
    return { S, at: (t) => ({ x: a.x, y: a.y, s: width / (w0 * Math.exp(RHO * t * S)) }) };
  }
  const d1 = Math.sqrt(d2);
  const r0 = -Math.asinh((w1 * w1 - w0 * w0 + 4 * d2) / (4 * w0 * d1));
  const r1 = -Math.asinh((w1 * w1 - w0 * w0 - 4 * d2) / (4 * w1 * d1));
  const S = (r1 - r0) / RHO;
  const c0 = Math.cosh(r0);
  return {
    S,
    at: (t) => {
      const v = RHO * t * S + r0;
      const u = (w0 / (2 * d1)) * (c0 * Math.tanh(v) - Math.sinh(r0));
      return { x: a.x + u * dx, y: a.y + u * dy, s: width / ((w0 * c0) / Math.cosh(v)) };
    },
  };
}

/** Where the camera is, and where it is flying. Every map that shares one flight (the dark map
    and, inside the blue flood, the blue one) draws the same camera at the same moment, because
    the camera is a function of the clock. */
export class Flight {
  private path: ((t: number) => Cam) | null = null;
  private start = 0;
  private ms = 0;
  /** The path's length in van Wijk and Nuij's measure. */
  private length = 0;
  /** How fast the flight leaves, as a share of its mean speed: 0 from a standstill. A flight that
      takes over from a moving camera leaves at the camera's own speed. */
  private launch = 0;
  private end: Cam;
  width: number;
  private readonly subs = new Set<() => void>();

  constructor(at: Cam, width: number) {
    this.end = at;
    this.width = width;
  }

  now(t = performance.now()): Cam {
    if (!this.path) return this.end;
    const k = (t - this.start) / this.ms;
    return k >= 1 ? this.end : this.path(this.ease(Math.max(0, k)));
  }

  moving(t = performance.now()): boolean {
    return this.path !== null && t < this.start + this.ms;
  }

  /** A new place, while flying too (the exact city lands halfway to the country): the flight
      bends toward it at the speed it has. */
  go(to: Cam): void {
    const t = performance.now();
    const here = this.now(t);
    const speed = this.speed(t);
    // Start every flight near longitude 0; the picture is the same 360° on.
    const turn = Math.round(here.x / 360) * 360;
    const from = { ...here, x: here.x - turn };
    const dest = { x: from.x + wrap180(to.x - from.x), y: to.y, s: to.s };
    const still = Math.abs(dest.x - from.x) < 1e-6 && Math.abs(dest.y - from.y) < 1e-6 && Math.abs(dest.s / from.s - 1) < 1e-4;
    this.end = dest;
    if (still || quiet()) {
      this.path = null;
    } else {
      const { at, S } = zoomPath(from, dest, this.width);
      this.path = at;
      this.start = t;
      this.length = Math.abs(S);
      this.ms = Math.min(2600, Math.max(650, this.length * 760));
      // Up to three times the mean speed: beyond that the curve would overshoot.
      this.launch = this.length > 1e-9 ? Math.max(0, Math.min(3, (speed * this.ms) / this.length)) : 0;
    }
    this.subs.forEach((fn) => fn());
  }

  /** Jump without a flight (the first frame, a window resized). */
  set(to: Cam): void {
    this.end = to;
    this.path = null;
    this.subs.forEach((fn) => fn());
  }

  listen(fn: () => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /** How fast the camera moves now, in path length per millisecond. */
  private speed(t: number): number {
    if (!this.path) return 0;
    const k = (t - this.start) / this.ms;
    return k <= 0 || k >= 1 ? 0 : (this.length * this.slope(k)) / this.ms;
  }

  /** From a standstill: smooth in and out. From a moving camera: leaves at its speed and only
      slows into the end (a cubic Hermite curve, never past the end for a launch up to 3). */
  private ease(t: number): number {
    if (this.launch === 0) return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    return (t * t * t - 2 * t * t + t) * this.launch + (-2 * t * t * t + 3 * t * t);
  }

  private slope(t: number): number {
    if (this.launch === 0) return t < 0.5 ? 12 * t * t : 3 * (2 - 2 * t) ** 2;
    return (3 * t * t - 4 * t + 1) * this.launch + (6 * t - 6 * t * t);
  }
}

/* ---------- painting ---------- */

/** A map's solid colours: the land, the exit's country a little farther (mid) and close to the
    city (near), and the city itself; close up, every country's border and the lit one's edge. */
export type Tone = { base: string; mid: string; near: string; nearest: string; border: string; edge: string };

export const TONES: Record<"dark" | "light" | "blue", Tone> = {
  // The phone's two (Tone.Dark, Tone.Blue), and one for the light look of the computer app.
  dark: { base: "#1a2132", mid: "#1b3b84", near: "#1d55d6", nearest: "#5d95ff", border: "#3b5490", edge: "#ffffff" },
  light: { base: "#d9dfea", mid: "#a8c1fb", near: "#5f8ff9", nearest: "#0158ff", border: "#aebbd6", edge: "#0158ff" },
  blue: { base: "#2a6cff", mid: "#4480ff", near: "#5f95ff", nearest: "#ffffff", border: "#86abff", edge: "#ffffff" },
};

export type Scene = {
  width: number;
  height: number;
  /** Where the camera's centre sits on the screen: the pin stands here. */
  px: number;
  py: number;
  /** The grid's spacing at rest, and a dot's radius, in pixels. */
  pitch: number;
  radius: number;
  tone: Tone;
  /** Light the exit's country, and the dots around the pin brightest. */
  lit: boolean;
  exit?: string;
  /** The country lit before `exit`: it fades out while `exit` fades in, `litK` going 0 to 1. */
  exitBefore?: string;
  litK: number;
  /** A pin stands at (px, py): at rest the place itself, in a flight the world slides under it. */
  pin: boolean;
};

/** Per map: which grid points are inside a lit country, per country (two while one fades). */
export type Memo = Map<string, Map<number, boolean>>;

/** The grid: level k has a dot every STEP / 2^k degrees. */
const STEP = 2.4;
const KMIN = -1;
const KMAX = 6;
const step = (k: number) => STEP / 2 ** k;
const ROW = 360 / step(KMAX);
/** How many steps a lit country's fade takes. */
const FADE_STEPS = 12;

/** From this closeness (pixels per degree; the world view is about 4, a city 140) the land and
    the lit country are read from the fine borders. */
const FINE_FROM = 20;
/** The borders step in between these two closenesses: none over the whole world, all of them
    by the time a country fills the window. */
const BORDER_FROM = 6;
const BORDER_FULL = 12;
const BORDER_STEPS = 8;

/** Land or sea per grid point, shared by every map: positive is land, negative sea, and its size
    is the scale it was read at (a point read far out is read again once the camera is closer).
    One for the world view's land, one for the fine borders. */
const LAND_AT = new Map<number, number>();
const LAND_FINE = new Map<number, number>();

const keyOf = (i: number, j: number) => (((i % ROW) + ROW) % ROW) * 40000 + (j + 20000);

let maskCanvas: HTMLCanvasElement | null = null;

/** The land as a picture of the screen, one CSS pixel a pixel: one solid shape per country. */
function landMask(set: Country[], cam: Cam, w: number, h: number, px: number, py: number): Uint8ClampedArray {
  maskCanvas ??= document.createElement("canvas");
  if (maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas.width = w;
    maskCanvas.height = h;
  }
  const g = maskCanvas.getContext("2d", { willReadFrequently: true })!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#000000";
  const s = cam.s;
  const vx0 = cam.x - px / s - 1;
  const vx1 = cam.x + (w - px) / s + 1;
  const vy0 = cam.y - (h - py) / s - 1;
  const vy1 = cam.y + py / s + 1;
  for (const c of set) {
    if (c.y1 < vy0 || c.y0 > vy1) continue;
    let any = false;
    g.beginPath();
    for (const r of c.rings) {
      if (r.y1 < vy0 || r.y0 > vy1) continue;
      for (let o = Math.ceil((vx0 - r.x1) / 360); o <= Math.floor((vx1 - r.x0) / 360); o++) {
        const ox = o * 360 - cam.x;
        const p = r.pts;
        g.moveTo(px + (p[0] + ox) * s, py - (p[1] - cam.y) * s);
        for (let k = 2; k < p.length; k += 2) g.lineTo(px + (p[k] + ox) * s, py - (p[k + 1] - cam.y) * s);
        g.closePath();
        any = true;
      }
    }
    if (any) g.fill("evenodd");
  }
  return g.getImageData(0, 0, w, h).data;
}

/** "#rrggbb" mixed with another, `k` of the way: a solid colour, never see-through. */
function mix(a: string, b: string, k: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - k) + ((pb >> shift) & 255) * k);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** Draws the map for one camera: a few thousand grid points from caches, the land drawn again
    only when a point has not been seen at this closeness. */
export function paint(ctx: CanvasRenderingContext2D, dpr: number, cam: Cam, sc: Scene, memo: Memo): void {
  const coarse = world();
  const { width: w, height: h, px, py, pitch, radius, tone } = sc;
  const s = cam.s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (w < 2 || h < 2) return;
  if (s >= BORDER_FROM / 2) loadBorders();
  // Close up, everything is read from the fine borders; a country they lack (Svalbard, which
  // Natural Earth keeps inside Norway) stays the world view's.
  const fine = FINE !== null && s >= FINE_FROM;
  const set = fine ? FINE! : coarse;
  const countryAt = (cc: string) => (fine ? FINE_BY_CC.get(cc) : undefined) ?? BY_CC.get(cc);
  const landAt = fine ? LAND_FINE : LAND_AT;

  // The finest level that shows, and how far its new dots have grown: they start the moment the
  // grid begins to spread (half the pitch) and are full when it has doubled.
  let kf = KMIN;
  for (let k = KMIN + 1; k <= KMAX; k++) if (step(k) * s >= 0.5 * pitch) kf = k;
  const d = step(kf);
  const grow = Math.max(0, Math.min(1, (d * s - 0.5 * pitch) / (0.5 * pitch)));
  const unit = 2 ** (KMAX - kf);

  const pad = radius / s;
  const i0 = Math.ceil((cam.x - px / s - pad) / d);
  const i1 = Math.floor((cam.x + (w - px) / s + pad) / d);
  const j0 = Math.ceil((cam.y - (h - py) / s - pad) / d);
  const j1 = Math.floor((cam.y + py / s + pad) / d);

  const exitCountry = sc.lit && sc.exit ? countryAt(sc.exit) : undefined;
  // The country lit before, while it fades out.
  const beforeCountry = sc.lit && sc.exitBefore && sc.exitBefore !== sc.exit && sc.litK < 1 ? countryAt(sc.exitBefore) : undefined;
  for (const key of memo.keys()) if (key !== exitCountry?.key && key !== beforeCountry?.key) memo.delete(key);
  const of = (c: Country) => {
    let m = memo.get(c.key);
    if (!m) memo.set(c.key, (m = new Map()));
    return m;
  };
  const inExit = exitCountry ? of(exitCountry) : undefined;
  const inBefore = beforeCountry ? of(beforeCountry) : undefined;
  // The fade in a few steps, each colour a blend of two solid ones: nothing see-through, and only
  // a few fill colours to draw.
  const fade = Math.round(Math.max(0, Math.min(1, sc.litK)) * FADE_STEPS) / FADE_STEPS;
  const nearIn = mix(tone.base, tone.near, fade);
  const midIn = mix(tone.base, tone.mid, fade);
  const nearOut = mix(tone.base, tone.near, 1 - fade);
  const midOut = mix(tone.base, tone.mid, 1 - fade);
  const pin = sc.lit && sc.pin;
  const nearest = 2.4 * pitch;
  const groups = new Map<string, number[]>();
  let mask: Uint8ClampedArray | null = null;
  if (landAt.size > 300000) landAt.clear();
  const mw = Math.max(1, Math.round(w));
  const mh = Math.max(1, Math.round(h));

  for (let j = j0; j <= j1; j++) {
    const y = j * d;
    const sy = py - (y - cam.y) * s;
    const oddRow = (j & 1) !== 0;
    for (let i = i0; i <= i1; i++) {
      const fresh = kf === KMIN || oddRow || (i & 1) !== 0;
      const r = fresh ? radius * grow : radius;
      if (r < 0.35) continue;
      const x = i * d;
      const sx = px + (x - cam.x) * s;
      const k = keyOf(i * unit, j * unit);
      let land = landAt.get(k);
      if (land === undefined || Math.abs(land) * 2 < s) {
        mask ??= landMask(set, cam, mw, mh, px, py);
        const mx = Math.min(mw - 1, Math.max(0, Math.floor(sx)));
        const my = Math.min(mh - 1, Math.max(0, Math.floor(sy)));
        land = mask[(my * mw + mx) * 4 + 3] >= 128 ? s : -s;
        // A point just past the edge was read from the edge: kept for this frame only, read
        // properly once it is on the screen.
        if (mx === Math.floor(sx) && my === Math.floor(sy)) landAt.set(k, land);
      }
      if (land < 0) continue;

      let colour = tone.base;
      let litNow = false;
      if (exitCountry && inExit) {
        let v = inExit.get(k);
        if (v === undefined) inExit.set(k, (v = insideCountry(exitCountry, x, y)));
        litNow = v;
      }
      let litBefore = false;
      if (!litNow && beforeCountry && inBefore) {
        let v = inBefore.get(k);
        if (v === undefined) inBefore.set(k, (v = insideCountry(beforeCountry, x, y)));
        litBefore = v;
      }
      if (litNow || litBefore) {
        const near = litNow ? nearIn : nearOut;
        const mid = litNow ? midIn : midOut;
        if (pin) {
          // Brightest by the city, then a step down, then the plain land: a glow in solid
          // colours, so a close-up never turns one flat field.
          const far = Math.hypot(sx - px, sy - py);
          colour = far < 10 * pitch ? near : far < 17 * pitch ? mid : tone.base;
        } else colour = near;
      }
      if (pin && Math.hypot(sx - px, sy - py) < nearest) colour = tone.nearest;

      let list = groups.get(colour);
      if (!list) groups.set(colour, (list = []));
      list.push(sx, sy, r);
    }
  }

  for (const [colour, list] of groups) {
    ctx.beginPath();
    for (let n = 0; n < list.length; n += 3) {
      ctx.moveTo(list[n] + list[n + 2], list[n + 1]);
      ctx.arc(list[n], list[n + 1], list[n + 2], 0, Math.PI * 2);
    }
    ctx.fillStyle = colour;
    ctx.fill();
  }

  // The borders, over the dots: they step in as the camera comes closer, in solid colours
  // between the land's and the line's.
  const bk = Math.round(Math.max(0, Math.min(1, (s - BORDER_FROM) / (BORDER_FULL - BORDER_FROM))) * BORDER_STEPS) / BORDER_STEPS;
  if (bk > 0) borders(ctx, cam, sc, set, bk, exitCountry, beforeCountry, fade);
}

/** Every border in view in one thin line, then the country lit before (handing its white edge
    over) and the lit one on top: the edge fades across with the lit country's dots. */
function borders(
  ctx: CanvasRenderingContext2D,
  cam: Cam,
  sc: Scene,
  set: Country[],
  bk: number,
  exit: Country | undefined,
  before: Country | undefined,
  fade: number,
): void {
  const { width: w, height: h, px, py, tone } = sc;
  const s = cam.s;
  const vx0 = cam.x - px / s - 0.5;
  const vx1 = cam.x + (w - px) / s + 0.5;
  const vy0 = cam.y - (h - py) / s - 0.5;
  const vy1 = cam.y + py / s + 0.5;
  const trace = (c: Country) => {
    if (c.y1 < vy0 || c.y0 > vy1) return;
    for (const r of c.rings) {
      if (r.y1 < vy0 || r.y0 > vy1) continue;
      for (let o = Math.ceil((vx0 - r.x1) / 360); o <= Math.floor((vx1 - r.x0) / 360); o++) traceRing(ctx, r.pts, o * 360 - cam.x, cam.y, s, px, py);
    }
  };
  const line = mix(tone.base, tone.border, bk);
  const edge = mix(tone.base, tone.edge, bk);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const c of set) if (c.cc !== exit?.cc && c.cc !== before?.cc) trace(c);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.stroke();
  for (const [c, k] of [
    [before, 1 - fade],
    [exit, fade],
  ] as const) {
    if (!c) continue;
    ctx.beginPath();
    trace(c);
    ctx.strokeStyle = mix(line, edge, k);
    ctx.lineWidth = 1 + 0.8 * k;
    ctx.stroke();
  }
}

/** On the cut at ±180° (the world view's own rings run on past it, and are never cut there). */
const onDateLine = (x: number) => Math.abs(Math.abs(x) - 180) < 0.005;

/** One ring as a line on the screen: a point closer than about a pixel to the last one drawn
    waits (a close-up of France draws its 800 points, the world view far fewer), and the cut
    Natural Earth makes along the date line is never drawn. */
function traceRing(ctx: CanvasRenderingContext2D, p: Float32Array, ox: number, camY: number, s: number, px: number, py: number): void {
  const n = p.length;
  let lx = px + (p[0] + ox) * s;
  let ly = py - (p[1] - camY) * s;
  ctx.moveTo(lx, ly);
  let waiting = false;
  let wx = 0;
  let wy = 0;
  for (let k = 2; k <= n; k += 2) {
    const at = k === n ? 0 : k; // the last step closes the ring
    const sx = px + (p[at] + ox) * s;
    const sy = py - (p[at + 1] - camY) * s;
    if (onDateLine(p[at]) && onDateLine(p[k - 2])) {
      if (waiting) ctx.lineTo(wx, wy);
      ctx.moveTo(sx, sy);
      lx = sx;
      ly = sy;
      waiting = false;
      continue;
    }
    if (k < n && Math.abs(sx - lx) + Math.abs(sy - ly) < 0.9) {
      waiting = true;
      wx = sx;
      wy = sy;
      continue;
    }
    ctx.lineTo(sx, sy);
    lx = sx;
    ly = sy;
    waiting = false;
  }
}
