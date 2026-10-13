import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Phase } from "./ConnectionCard";
import { COUNTRY_CELLS, GRID, LABELS, OTHER_LAND } from "./worldDots";

/* The Map look's picture (lib/look.ts): every land cell of the world as a dot,
   the country you appear in lit in HProxy blue, a ring where a small country's
   name sits (Singapore, Malta have no dot of their own).

   Connected, the map flies in to the exit's country and shows its city as a
   dot, smoothly: a canvas, redrawn on every frame of the flight with the dots
   at a steady size, where scaling a picture made them swell into blobs. The coarse world (3 degrees, worldDots.ts) hands
   over to one three times finer (worldDotsFine.ts, loaded the first time the
   map zooms) as the view closes in, so a small country is a shape and not
   three dots. Only the dots in view are drawn, and only while something
   moves: at rest the map costs nothing. The city dot and its pulse are one
   small element over the canvas, which the graphics card animates. */

/** The rows shown: the far Arctic (above 78° north) is left out. */
const FIRST_ROW = 2;
const VIEW_W = GRID.cols;
const VIEW_H = GRID.rows - FIRST_ROW;
type Box = { x: number; y: number; w: number; h: number };
const WORLD: Box = { x: 0, y: FIRST_ROW, w: VIEW_W, h: VIEW_H };
/** Zoomed in, the box is at least this many cells wide: five times closer
    than the whole world, where a small country is still a shape. */
const MIN_ZOOM_WIDTH = 24;
/** A dot's radius as a share of its cell: the land, and the lit country. */
const R_LAND = 0.32;
const R_HERE = 0.4;
/** How long the flight takes, in and out. */
const FLY_MS = 1300;
const TAU = Math.PI * 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function cellsOf(list: string): number[] {
  return list ? list.split(",").map((c) => parseInt(c, 36)) : [];
}

/** Cell centres in coarse cells, [x0, y0, x1, y1, ...]: `unit` is how many
    coarse cells one of these cells is (1 for the coarse world, 1/3 fine). */
function centres(cells: number[], cols: number, unit: number): Float32Array {
  const out = new Float32Array(cells.length * 2);
  cells.forEach((cell, i) => {
    out[i * 2] = ((cell % cols) + 0.5) * unit;
    out[i * 2 + 1] = (Math.floor(cell / cols) + 0.5) * unit;
  });
  return out;
}

let coarseLand: Float32Array | null = null;
const coarseCountry = new Map<string, Float32Array>();
function coarse(cc?: string): { land: Float32Array; here?: Float32Array } {
  coarseLand ??= centres([...Object.values(COUNTRY_CELLS).flatMap(cellsOf), ...cellsOf(OTHER_LAND)], GRID.cols, 1);
  if (!cc) return { land: coarseLand };
  let here = coarseCountry.get(cc);
  if (!here) coarseCountry.set(cc, (here = centres(cellsOf(COUNTRY_CELLS[cc] ?? ""), GRID.cols, 1)));
  return { land: coarseLand, here };
}

type Fine = typeof import("./worldDotsFine");
let fineWorld: Fine | null = null;
let fineLoading: Promise<Fine> | null = null;
function loadFine(): Promise<Fine> {
  fineLoading ??= import("./worldDotsFine").then((m) => (fineWorld = m));
  return fineLoading;
}
let fineLand: Float32Array | null = null;
const fineCountry = new Map<string, Float32Array>();
function fineDots(f: Fine, cc?: string): { land: Float32Array; here?: Float32Array } {
  const cols = f.FINE_GRID.cols;
  fineLand ??= centres([...Object.values(f.FINE_COUNTRY_CELLS).flatMap(cellsOf), ...cellsOf(f.FINE_OTHER_LAND)], cols, 1 / 3);
  if (!cc) return { land: fineLand };
  let here = fineCountry.get(cc);
  if (!here) fineCountry.set(cc, (here = centres(cellsOf(f.FINE_COUNTRY_CELLS[cc] ?? ""), cols, 1 / 3)));
  return { land: fineLand, here };
}

/** A place on the grid: 3° cells, row 0 at 84° north, column 0 at 180° west. */
export function cellOf(lat: number, lon: number): readonly [number, number] {
  return [(lon + 180) / 3, (84 - lat) / 3];
}

/** The box to fly in to, in cells, in the strip's own shape and inside the
    world: around the city when it is known, else the middle of the country,
    wide enough to hold the whole country with room around it. */
export function zoomBox(cc: string, city?: readonly [number, number]): Box | null {
  const cells = cellsOf(COUNTRY_CELLS[cc] ?? "");
  const label = LABELS[cc];
  let minX: number, minY: number, maxX: number, maxY: number;
  if (cells.length) {
    const xs = cells.map((c) => c % GRID.cols);
    const ys = cells.map((c) => Math.floor(c / GRID.cols));
    [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs) + 1, Math.min(...ys), Math.max(...ys) + 1];
  } else if (label || city) {
    const [x, y] = city ?? label!;
    [minX, maxX, minY, maxY] = [x - 0.5, x + 0.5, y - 0.5, y + 0.5];
  } else {
    return null;
  }
  const w = Math.min(VIEW_W, Math.max(MIN_ZOOM_WIDTH, (maxX - minX) * 1.6, ((maxY - minY) * 1.6 * VIEW_W) / VIEW_H));
  const h = (w * VIEW_H) / VIEW_W;
  const [cx, cy] = city ?? [(minX + maxX) / 2, (minY + maxY) / 2];
  return { x: clamp(cx - w / 2, 0, VIEW_W - w), y: clamp(cy - h / 2, FIRST_ROW, FIRST_ROW + VIEW_H - h), w, h };
}

/** Between two boxes: the middle moves straight, the width in steps that
    feel even (logarithmic), so flying in does not rush at the end. */
function between(a: Box, b: Box, t: number): Box {
  const w = Math.exp(Math.log(a.w) + (Math.log(b.w) - Math.log(a.w)) * t);
  const cx = a.x + a.w / 2 + (b.x + b.w / 2 - (a.x + a.w / 2)) * t;
  const cy = a.y + a.h / 2 + (b.y + b.h / 2 - (a.y + a.h / 2)) * t;
  const h = (w * VIEW_H) / VIEW_W;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const same = (a: Box, b: Box) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.w - b.w) < 1e-3;

/** A CSS colour as [r, g, b]: "#rrggbb", "#rgb" or "rgb(a)(…)". */
function rgbOf(css: string): [number, number, number] | null {
  const v = css.trim();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** The land's colour: the words' colour, a little of it, mixed into the card
    as a solid colour (nothing see-through), and the lit country's blue. */
function colours(el: Element): { land: string; here: string } {
  const s = getComputedStyle(el);
  const ink = rgbOf(s.getPropertyValue("--ink")) ?? [15, 17, 26];
  const card = rgbOf(s.getPropertyValue("--card")) ?? rgbOf(s.getPropertyValue("--surface")) ?? [255, 255, 255];
  const mix = ink.map((c, i) => Math.round(c * 0.16 + card[i] * 0.84));
  return { land: `rgb(${mix.join(",")})`, here: s.getPropertyValue("--digi").trim() || "#0158ff" };
}

type Props = { cc?: string; phase?: Phase; zoom?: boolean; lat?: number | null; lon?: number | null };

function DotMap({ cc, phase = "off", zoom = false, lat, lon }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cityRef = useRef<HTMLSpanElement>(null);
  const pinRef = useRef<HTMLSpanElement>(null);
  const [fine, setFine] = useState<Fine | null>(fineWorld);

  const code = cc?.toLowerCase();
  const city = lat != null && lon != null ? cellOf(lat, lon) : undefined;
  const target = (zoom && code && zoomBox(code, city)) || WORLD;
  const label = code ? LABELS[code] : undefined;

  // Everything the frames read, current without re-rendering.
  const now = useRef({ code, phase, city, label, fine, zoom });
  now.current = { code, phase, city, label, fine, zoom };
  const anim = useRef({ box: WORLD, from: WORLD, to: WORLD, start: 0, lit: 0, raf: 0, colours: null as null | { land: string; here: string } });

  useEffect(() => {
    if (zoom && !fine) void loadFine().then(setFine, () => {});
  }, [zoom, fine]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !wrap || !ctx) return;
    const a = anim.current;
    const { code, city, label, fine, zoom } = now.current;
    a.colours ??= colours(wrap);
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!W || !H) return;

    const box = a.box;
    // Fit the box to the canvas, whole and centred (like "meet").
    const scale = Math.min(W / box.w, H / box.h);
    const ox = (W - box.w * scale) / 2 - box.x * scale;
    const oy = (H - box.h * scale) / 2 - box.y * scale;
    const [x0, x1] = [-ox / scale - 1, (W - ox) / scale + 1];
    const [y0, y1] = [-oy / scale - 1, (H - oy) / scale + 1];
    // The whole world's scale: dots never grow past a little over its size.
    const base = Math.min(W / VIEW_W, H / VIEW_H);
    const closeness = VIEW_W / box.w;
    const fineShare = fine ? smoothstep(1.3, 2.1, closeness) : 0;

    const dots = (xy: Float32Array, r: number) => {
      ctx.beginPath();
      for (let i = 0; i < xy.length; i += 2) {
        const x = xy[i];
        const y = xy[i + 1];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const px = ox + x * scale;
        const py = oy + y * scale;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, TAU);
      }
      ctx.fill();
    };
    const layer = (world: { land: Float32Array; here?: Float32Array }, cell: number, share: number) => {
      if (share <= 0.01) return;
      ctx.globalAlpha = share;
      ctx.fillStyle = a.colours!.land;
      dots(world.land, Math.min(R_LAND * cell, R_LAND * base * 1.3));
      if (world.here && a.lit > 0.01) {
        ctx.globalAlpha = share * a.lit;
        ctx.fillStyle = a.colours!.here;
        dots(world.here, Math.min(R_HERE * cell, R_HERE * base * 1.3));
      }
    };
    layer(coarse(code), scale, 1 - fineShare);
    if (fine) layer(fineDots(fine, code), scale / 3, fineShare);
    ctx.globalAlpha = 1;

    // The city dot and the small country's ring sit over the canvas, in CSS pixels.
    const dpr = W / (canvas.clientWidth || W);
    const place = (el: HTMLElement | null, at: readonly [number, number] | undefined, show: boolean) => {
      if (!el) return;
      el.dataset.show = show && at ? "1" : "0";
      if (at) el.style.transform = `translate(${((ox + at[0] * scale) / dpr).toFixed(1)}px, ${((oy + at[1] * scale) / dpr).toFixed(1)}px)`;
    };
    const lit = a.lit > 0.5;
    place(cityRef.current, city, !!(zoom && city && lit));
    place(pinRef.current, label, !!(label && lit && !(zoom && city)));
  }, []);

  // One loop while something moves: the flight, the country lighting up, or
  // the country blinking while it connects. It stops the moment all rest.
  const run = useCallback(() => {
    const a = anim.current;
    if (a.raf) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const frame = (t: number) => {
      const { phase } = now.current;
      const flight = reduce ? 1 : clamp((t - a.start) / FLY_MS, 0, 1);
      a.box = flight >= 1 ? a.to : between(a.from, a.to, easeInOut(flight));
      const pulsing = phase === "connecting" || phase === "rotating" || phase === "switching";
      const litTo = phase === "on" ? 1 : pulsing ? 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t / 260)) : 0;
      a.lit += (litTo - a.lit) * (reduce ? 1 : 0.14);
      draw();
      const settled = flight >= 1 && !pulsing && Math.abs(litTo - a.lit) < 0.01;
      if (settled) {
        a.lit = litTo;
        draw();
        a.raf = 0;
        return;
      }
      a.raf = requestAnimationFrame(frame);
    };
    a.raf = requestAnimationFrame(frame);
  }, [draw]);

  // A new place to be: fly there from wherever the view is now.
  useEffect(() => {
    const a = anim.current;
    if (same(a.to, target)) return;
    a.from = a.box;
    a.to = target;
    a.start = performance.now();
    run();
  }, [target.x, target.y, target.w, run]); // eslint-disable-line react-hooks/exhaustive-deps

  // The country lighting up, blinking, or going dark; the fine world arriving.
  useEffect(() => {
    run();
  }, [phase, code, fine, run]);

  // The canvas at the screen's own resolution, redrawn when its size or the
  // look (white, dark, another background) changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(wrap.clientWidth * dpr);
      const h = Math.round(wrap.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      draw();
    };
    fit();
    const sized = new ResizeObserver(fit);
    sized.observe(wrap);
    const looked = new MutationObserver(() => {
      anim.current.colours = null;
      draw();
    });
    looked.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-surface", "data-bg"] });
    return () => {
      sized.disconnect();
      looked.disconnect();
      cancelAnimationFrame(anim.current.raf);
      anim.current.raf = 0;
    };
  }, [draw]);

  return (
    <div ref={wrapRef} className="ux-map" aria-hidden="true">
      <canvas ref={canvasRef} />
      <span ref={pinRef} className="ux-map-pin" data-show="0">
        <i className="ring" />
        <i className="dot" />
      </span>
      <span ref={cityRef} className="ux-map-city" data-show="0">
        <i className="ring" />
        <i className="dot" />
      </span>
    </div>
  );
}

export default memo(DotMap);
