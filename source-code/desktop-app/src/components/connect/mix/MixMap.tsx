import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { loadBorders, onBorders, onScreen, paint, type Cam, type Flight, type Memo, type Scene } from "./worldMap";

/** The lit country's handover, shared by every map on the page: `exit` fades in from `start`
    while `before` fades out (the phone's 900 ms on its Glide curve). */
export type Fade = { exit?: string; before?: string; start: number };

export const FADE_MS = 900;

/** A CSS cubic-bezier easing, solved for x. */
function curve(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

/** The phone's Glide easing, cubic-bezier(0.2, 0.9, 0.1, 1). */
export const glide = curve(0.2, 0.9, 0.1, 1);
/** The phone's Spring, cubic-bezier(0.34, 1.45, 0.6, 1): it goes a little past the end and back. */
const spring = curve(0.34, 1.45, 0.6, 1);

export function fadeAt(f: Fade, t = performance.now()): number {
  return f.before === undefined ? 1 : glide((t - f.start) / FADE_MS);
}

const fading = (f: Fade) => f.before !== undefined && performance.now() - f.start < FADE_MS + 32;

/** The pin's place on the world (Mercator degrees, as a camera's centre), shared by every map on
    the page, and since when it is there: a new place makes the pin come up there, growing from
    nothing on the Spring curve (the knob's 520 ms). Until 0.3.8 the pin stood in one spot of the
    window and the map slid under it, so in a flight it pointed at whatever passed under it. */
export type PinPlace = { x: number; y: number; since: number };

export const POP_MS = 520;

const still = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function popAt(p: PinPlace, t = performance.now()): number {
  return still() ? 1 : spring((t - p.since) / POP_MS);
}

const popping = (p: PinPlace) => performance.now() - p.since < POP_MS + 32;

/** Where the pin stands for this camera, and how far it has come up. */
const pinTransform = (p: PinPlace, cam: Cam, scene: Pick<Scene, "px" | "py">) => {
  const at = onScreen(p, cam, scene);
  return { at, css: `translate(${at.x}px, ${at.y}px) scale(${popAt(p)})` };
};

type Props = {
  flight: Flight;
  fade: { current: Fade };
  place: { current: PinPlace };
  /** The scene without the fade, which the map reads from `fade` on every frame. */
  scene: Omit<Scene, "exit" | "exitBefore" | "litK">;
  /** Covered by something solid: keeps its last frame and draws nothing new. */
  hidden?: boolean;
  /** Bumped by the page when a fade starts, so a resting map wakes up for it. */
  fadeKey: number;
  className?: string;
  children?: ReactNode;
};

/** One map on the page. One flight drives both maps (the dark one, and inside the blue flood the
    blue one); each draws frames only while the camera flies, a country fades or the pin comes up. */
function MixMap({ flight, fade, place, scene, hidden = false, fadeKey, className, children }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const memo = useRef<Memo>(new Map());
  const now = useRef({ scene, hidden });
  now.current = { scene, hidden };
  const run = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const draw = () => {
      const { scene, hidden } = now.current;
      if (hidden) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(scene.width * dpr);
      const h = Math.round(scene.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const f = fade.current;
      const cam = flight.now();
      // The pin moves with the map, on the same frame.
      const pin = pinTransform(place.current, cam, scene);
      if (pinRef.current) pinRef.current.style.transform = pin.css;
      paint(ctx, dpr, cam, { ...scene, exit: f.exit, exitBefore: f.before, litK: fadeAt(f), pinAt: pin.at }, memo.current);
    };
    const loop = () => {
      draw();
      raf = flight.moving() || fading(fade.current) || popping(place.current) ? requestAnimationFrame(loop) : 0;
    };
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    run.current = wake;
    wake();
    const off = flight.listen(wake);
    // The fine borders arrive: a close-up draws again with them.
    const offBorders = onBorders(wake);
    // They load while the page rests, before the first close-up needs them.
    const early = window.setTimeout(loadBorders, 500);
    return () => {
      off();
      offBorders();
      clearTimeout(early);
      cancelAnimationFrame(raf);
      run.current = null;
    };
  }, [flight, fade, place]);

  // A new scene (lit, size, colours), uncovered again, or a fade starting: wake the loop.
  useEffect(() => {
    run.current?.();
  }, [hidden, fadeKey, scene.width, scene.height, scene.px, scene.py, scene.lit, scene.pin, scene.tone, scene.pitch, scene.radius]);

  return (
    <div className={className} aria-hidden="true">
      <canvas ref={canvasRef} style={{ width: scene.width, height: scene.height }} />
      {children && scene.pin && (
        // The pin stands on its place and rides the map in a flight; every frame moves it
        // (draw, above). Where it is at this moment, so a render never puts it anywhere else.
        <div ref={pinRef} className="mix-pin-at" style={{ transform: pinTransform(place.current, flight.now(), scene).css }}>
          {children}
        </div>
      )}
    </div>
  );
}

export default memo(MixMap);
