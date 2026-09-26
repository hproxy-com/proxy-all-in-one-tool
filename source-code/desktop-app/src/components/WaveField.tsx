import { useEffect, useRef } from "react";

/**
 * The HProxy dotted-wave background, ported from the website's WaveField.
 * The signature "waves" ribbons, drawn from the active theme's --wave-*
 * CSS variables so the dots recolor automatically in Midnight mode.
 *
 * Keeps the website's performance discipline: static first frame, ~30fps cap,
 * pauses when off-screen, honors prefers-reduced-motion.
 */
export default function WaveField({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = false;
    let onScreen = false;
    let w = 0;
    let h = 0;

    let baseRgb = "126, 168, 255";
    let crestRgb = "214, 228, 255";
    let glintRgb = "64, 224, 208";

    const readColors = () => {
      const style = getComputedStyle(document.documentElement);
      baseRgb = style.getPropertyValue("--wave-base").trim() || baseRgb;
      crestRgb = style.getPropertyValue("--wave-crest").trim() || crestRgb;
      glintRgb = style.getPropertyValue("--wave-glint").trim() || glintRgb;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const hash = (x: number, y: number) => {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };

    const dot = (x: number, y: number, r: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };

    const pick = (n: number, glint: number, alpha: number) => {
      if (n > 0.72 && glint < 0.05) return `rgba(${glintRgb}, ${alpha + 0.1})`;
      if (n > 0.88) return `rgba(${crestRgb}, ${alpha + 0.15})`;
      return `rgba(${baseRgb}, ${alpha})`;
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const gapX = 17;
      const gapY = 24;
      const cols = Math.ceil(w / gapX) + 2;
      const rows = Math.ceil(h / gapY) + 3;
      for (let j = 0; j < rows; j++) {
        const gy = j * gapY;
        for (let i = 0; i < cols; i++) {
          const gx = i * gapX;
          const w1 = Math.sin(gx * 0.006 + t * 0.45 + gy * 0.004);
          const w2 = Math.sin(gx * 0.012 - t * 0.3 + gy * 0.01 + 2.1);
          const w3 = Math.sin(gx * 0.003 + gy * 0.008 + t * 0.22 + 4.2);
          const n = (w1 + w2 + w3) / 6 + 0.5;
          const y = gy + w1 * 10 + w2 * 6;
          const alpha = 0.04 + Math.pow(n, 2.4) * 0.5;
          dot(gx, y, 0.7 + n * 1.5, pick(n, hash(i, j), alpha));
        }
      }
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const FRAME_MS = 33;
    let lastFrame = 0;
    const loop = (ms: number) => {
      raf = requestAnimationFrame(loop);
      if (ms - lastFrame < FRAME_MS) return;
      lastFrame = ms;
      draw(ms / 1000);
    };

    const start = () => {
      if (running || reduced || !onScreen) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    readColors();
    resize();
    draw(0);

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        if (onScreen) start();
        else stop();
      },
      { threshold: 0.05 },
    );
    io.observe(canvas);

    const onResize = () => {
      resize();
      if (!running) draw(0);
    };
    window.addEventListener("resize", onResize);

    // Recolor live when the theme flips (Electric <-> Midnight).
    const mo = new MutationObserver(() => {
      readColors();
      if (!running) draw(0);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      stop();
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      aria-hidden="true"
    />
  );
}
