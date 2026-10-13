import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { loadBorders, onBorders, paint, type Flight, type Memo, type Scene } from "./worldMap";

/** The lit country's handover, shared by every map on the page: `exit` fades in from `start`
    while `before` fades out (the phone's 900 ms on its Glide curve). */
export type Fade = { exit?: string; before?: string; start: number };

export const FADE_MS = 900;

/** The phone's Glide easing, cubic-bezier(0.2, 0.9, 0.1, 1), solved for x. */
export function glide(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = [0.2, 0.9, 0.1, 1];
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

export function fadeAt(f: Fade, t = performance.now()): number {
  return f.before === undefined ? 1 : glide((t - f.start) / FADE_MS);
}

const fading = (f: Fade) => f.before !== undefined && performance.now() - f.start < FADE_MS + 32;

type Props = {
  flight: Flight;
  fade: { current: Fade };
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
    blue one); each draws frames only while the camera flies or a country fades. */
function MixMap({ flight, fade, scene, hidden = false, fadeKey, className, children }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
      paint(ctx, dpr, flight.now(), { ...scene, exit: f.exit, exitBefore: f.before, litK: fadeAt(f) }, memo.current);
    };
    const loop = () => {
      draw();
      raf = flight.moving() || fading(fade.current) ? requestAnimationFrame(loop) : 0;
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
  }, [flight, fade]);

  // A new scene (lit, size, colours), uncovered again, or a fade starting: wake the loop.
  useEffect(() => {
    run.current?.();
  }, [hidden, fadeKey, scene.width, scene.height, scene.px, scene.py, scene.lit, scene.pin, scene.tone, scene.pitch, scene.radius]);

  return (
    <div className={className} aria-hidden="true">
      <canvas ref={canvasRef} style={{ width: scene.width, height: scene.height }} />
      {children && scene.pin && (
        // The pin stands where the camera keeps the place; the map moves under it.
        <div className="mix-pin-at" style={{ transform: `translate(${scene.px}px, ${scene.py}px)` }}>
          {children}
        </div>
      )}
    </div>
  );
}

export default memo(MixMap);
