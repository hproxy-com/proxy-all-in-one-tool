// film.mjs: what the marketing films share, the app's (scripts/marketing-video.mjs) and the
// extension's (chrome-extension/scripts/marketing-video.mjs).
//   CLOCK: a clock the recorder moves itself, put into a page before its own code. setTimeout,
//     setInterval, requestAnimationFrame, performance.now and Date stand still until
//     __clock.step(ms) moves them; CSS transitions and animations are paused as they start and set
//     to the same time. Capturing a frame takes 80 ms or more, so in real time a film would
//     stutter; on this clock every frame is exactly one step after the last.
//   writeFilm: the frames as H.264 by the browser itself (WebCodecs), one quantizer per frame by
//     how much of the picture changed, one keyframe; the colours turned into BT.709 video range
//     here, so the file can say what they are (mp4.mjs, colr) and the brand blue stays the brand
//     blue. Its first frame becomes the WebP poster.
// Every film loops: its last frame must be its first. writeFilm measures the two and drops the
// last, then turns the loop round to start at the frame asked for.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigate, newPage } from "../../chrome-extension/tests/e2e/cdp.mjs";
import { mp4 } from "./mp4.mjs";

export const CLOCK = String.raw`(() => {
  if (window.__clock) return;
  const RealDate = Date;
  const offset = RealDate.now();
  let now = 0;
  const errors = [];
  const timers = new Map();
  const frames = new Map();
  let seq = 1;
  const add = (fn, delay, args, every) => {
    const id = seq++;
    timers.set(id, { fn, args, due: now + Math.max(0, Number(delay) || 0), every });
    return id;
  };
  window.setTimeout = function (fn, delay, ...args) { return add(fn, delay, args, null); };
  window.setInterval = function (fn, delay, ...args) { return add(fn, delay, args, Math.max(1, Number(delay) || 0)); };
  window.clearTimeout = window.clearInterval = function (id) { timers.delete(id); };
  window.requestAnimationFrame = function (cb) { const id = seq++; frames.set(id, cb); return id; };
  window.cancelAnimationFrame = function (id) { frames.delete(id); };
  performance.now = function () { return now; };
  const ClockDate = function (...a) {
    if (!new.target) return new RealDate(offset + now).toString();
    return a.length === 0 ? new RealDate(offset + now) : new RealDate(...a);
  };
  ClockDate.prototype = RealDate.prototype;
  ClockDate.now = () => Math.round(offset + now);
  ClockDate.parse = RealDate.parse;
  ClockDate.UTC = RealDate.UTC;
  window.Date = ClockDate;
  // A real turn of the event loop, for what the page schedules itself (React renders on a MessageChannel).
  const turn = () => new Promise((done) => { const c = new MessageChannel(); c.port1.onmessage = () => done(); c.port2.postMessage(0); });
  const run = (fn, args) => {
    if (typeof fn !== "function") return;
    try { fn.apply(window, args); } catch (e) { errors.push(String((e && e.stack) || e)); }
  };
  // CSS transitions and animations: paused the moment they start, then set to the clock's time.
  const driven = new WeakMap();
  const settle = () => {
    for (const a of document.getAnimations()) {
      let d = driven.get(a);
      if (!d) {
        if (a.playState !== "running") continue;
        d = { start: now, done: false };
        driven.set(a, d);
        a.pause();
      }
      if (d.done) continue;
      const rate = a.playbackRate || 1;
      const t = (now - d.start) * rate;
      const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
      if (rate > 0 && Number.isFinite(end) && t >= end) {
        d.done = true;
        try { a.finish(); } catch { a.currentTime = end; }
      } else a.currentTime = t;
    }
  };
  window.__clock = {
    errors,
    async step(ms) {
      const until = now + ms;
      for (let guard = 0; guard < 5000; guard++) {
        let id = 0, next = null;
        for (const [k, t] of timers) if (t.due <= until && (!next || t.due < next.due || (t.due === next.due && k < id))) { id = k; next = t; }
        if (!next) break;
        if (next.due > now) now = next.due;
        if (next.every != null) next.due = now + next.every; else timers.delete(id);
        run(next.fn, next.args);
        await turn();
      }
      now = until;
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) run(cb, [now]);
      await turn(); await turn(); await turn();
      settle();
    },
  };
})();`;

// The encoder, in a page of its own (WebCodecs needs a secure one).
const ENCODER = String.raw`(() => {
  const chunks = [];
  let description = null, failed = null, enc = null, W = 0, H = 0;
  const toB64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  // RGB to BT.709 video range, 4:2:0: what mp4.mjs's colr box says.
  const i420 = (rgba) => {
    const y = new Uint8Array(W * H), cw = W >> 1, ch = H >> 1;
    const u = new Uint8Array(cw * ch), v = new Uint8Array(cw * ch);
    for (let p = 0, q = 0; p < W * H; p++, q += 4) {
      y[p] = Math.round(16 + 219 * (0.2126 * rgba[q] + 0.7152 * rgba[q + 1] + 0.0722 * rgba[q + 2]) / 255);
    }
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        let cb = 0, cr = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const q = ((2 * j + dy) * W + 2 * i + dx) * 4;
          const r = rgba[q] / 255, g = rgba[q + 1] / 255, b = rgba[q + 2] / 255;
          cb += -0.1146 * r - 0.3854 * g + 0.5 * b;
          cr += 0.5 * r - 0.4542 * g - 0.0458 * b;
        }
        u[j * cw + i] = Math.round(128 + 224 * cb / 4);
        v[j * cw + i] = Math.round(128 + 224 * cr / 4);
      }
    }
    const all = new Uint8Array(W * H + 2 * cw * ch);
    all.set(y, 0);
    all.set(u, W * H);
    all.set(v, W * H + cw * ch);
    return all;
  };
  const ctx = () => {
    const c = new OffscreenCanvas(W, H);
    return c.getContext("2d", { willReadFrequently: true });
  };
  let g = null, last = null;
  // The share of the picture that changed since the last frame, 0 to 1.
  const moved = (rgba) => {
    const now = new Uint32Array(rgba.buffer.slice(0));
    if (!last) { last = now; return 1; }
    let n = 0;
    for (let i = 0; i < now.length; i++) if (now[i] !== last[i]) n++;
    last = now;
    return n / now.length;
  };
  window.__video = {
    async start(w, h, fps, sharp, moving) {
      W = w; H = h; g = null; last = null;
      enc = new VideoEncoder({
        output: (chunk, meta) => {
          if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) description = new Uint8Array(meta.decoderConfig.description);
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          chunks.push({ key: chunk.type === "key", ts: chunk.timestamp, b });
        },
        error: (e) => { failed = String(e); },
      });
      const config = { codec: "avc1.640028", width: w, height: h, framerate: fps, bitrateMode: "quantizer", latencyMode: "quality", avc: { format: "avc" } };
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (!supported) throw new Error("this browser cannot encode " + JSON.stringify(config));
      enc.configure(config);
      this.sharp = sharp;
      this.moving = moving;
    },
    async add(png, n, fps) {
      const bin = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
      g = g || ctx();
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const rgba = g.getImageData(0, 0, W, H).data;
      const share = n === 0 ? 0 : moved(rgba);
      if (n === 0) moved(rgba);
      const k = Math.min(1, Math.max(0, (share - 0.08) / 0.27));
      const qp = Math.round(this.sharp + (this.moving - this.sharp) * k);
      const frame = new VideoFrame(i420(rgba), {
        format: "I420", codedWidth: W, codedHeight: H,
        timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps),
        colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
      });
      enc.encode(frame, { keyFrame: n === 0, avc: { quantizer: qp } });
      frame.close();
      while (enc.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 2));
      if (failed) throw new Error(failed);
      return qp;
    },
    async finish() {
      await enc.flush();
      enc.close();
      if (failed) throw new Error(failed);
      if (!description) throw new Error("the encoder gave no decoder description");
      return { description: toB64(description), chunks: chunks.map((c) => ({ key: c.key, ts: c.ts, b: toB64(c.b) })) };
    },
    // How many pixels two frames differ in, and where: the loop's two ends must be the same. Chrome
    // dithers a gradient (the logo's H), so the same picture can come out a level or two apart in
    // a few pixels, far below what the encoder keeps: only a bigger step counts.
    async differ(a, b) {
      const read = async (png) => {
        const bin = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
        const w = bmp.width;
        const c = new OffscreenCanvas(w, bmp.height).getContext("2d", { willReadFrequently: true });
        c.drawImage(bmp, 0, 0);
        bmp.close();
        return { w, px: c.getImageData(0, 0, c.canvas.width, c.canvas.height).data };
      };
      const [pa, pb] = [await read(a), await read(b)];
      let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let i = 0; i < pa.px.length / 4; i++) {
        const q = i * 4;
        if (Math.max(Math.abs(pa.px[q] - pb.px[q]), Math.abs(pa.px[q + 1] - pb.px[q + 1]), Math.abs(pa.px[q + 2] - pb.px[q + 2])) <= 2) continue;
        n++;
        const x = i % pa.w, y = Math.floor(i / pa.w);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { n, box: n ? [x0, y0, x1, y1] : null };
    },
    async poster(png, quality) {
      const bin = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext("2d", { alpha: false }).drawImage(bmp, 0, 0);
      bmp.close();
      return toB64(new Uint8Array(await (await c.convertToBlob({ type: "image/webp", quality })).arrayBuffer()));
    },
  };
})();`;

/**
 * The film from its frames (PNG in base64, in the order recorded) in a page of its own at
 * `coderUrl`, which must be a secure one (an http://localhost page, an extension's page).
 * `start` is the frame the film opens on, and its poster. Writes `mp4File` and `posterFile`
 * (and every frame into `framesDir`, when given); what went wrong goes into `problems`.
 */
export async function writeFilm(cdp, { coderUrl, shots, start, width, height, fps, sharp, moving, mp4File, posterFile, framesDir, problems }) {
  const coder = await newPage(cdp, { width: 400, height: 300 });
  const run = (e, ms) => cdp.evaluate(coder.sessionId, e, ms);
  await navigate(cdp, coder.sessionId, coderUrl, 60_000);
  if (!(await run("isSecureContext"))) throw new Error("the encoder page is not a secure context");
  await run(ENCODER);
  // The last frame is the first one again: measured, then dropped, or the join would stand still
  // for a frame.
  const seam = await run(`__video.differ(${JSON.stringify(shots[0])}, ${JSON.stringify(shots.at(-1))})`);
  if (seam.n) {
    problems.push(`the film's two ends differ in ${seam.n} pixels, from ${seam.box.slice(0, 2)} to ${seam.box.slice(2)}: the loop would jump`);
    if (framesDir) {
      writeFileSync(join(framesDir, "seam-first.png"), Buffer.from(shots[0], "base64"));
      writeFileSync(join(framesDir, "seam-last.png"), Buffer.from(shots.at(-1), "base64"));
    }
  }
  const film = [...shots.slice(start, -1), ...shots.slice(0, start)];
  await run(`__video.start(${width}, ${height}, ${fps}, ${sharp}, ${moving})`);
  const used = {};
  for (const [n, png] of film.entries()) {
    if (framesDir) writeFileSync(join(framesDir, `${String(n + 1).padStart(4, "0")}.png`), Buffer.from(png, "base64"));
    const qp = await run(`__video.add(${JSON.stringify(png)}, ${n}, ${fps})`);
    used[qp] = (used[qp] ?? 0) + 1;
  }
  const { description, chunks } = await run(`__video.finish()`, 300_000);
  if (chunks.length !== film.length) throw new Error(`${film.length} frames went in, ${chunks.length} came out`);
  chunks.forEach((c, i) => {
    if (i && c.ts <= chunks[i - 1].ts) throw new Error("the encoder reordered frames; mp4.mjs writes them in display order only");
  });
  const file = mp4({
    width,
    height,
    timescale: fps * 1000,
    description: Buffer.from(description, "base64"),
    samples: chunks.map((c) => ({ data: Buffer.from(c.b, "base64"), duration: 1000, key: c.key })),
  });
  writeFileSync(mp4File, file);
  const poster = Buffer.from(await run(`__video.poster(${JSON.stringify(film[0])}, 0.82)`), "base64");
  writeFileSync(posterFile, poster);
  const qps = Object.entries(used).map(([q, n]) => `${n} at ${q}`).join(", ");
  return `${film.length} frames, ${(film.length / fps).toFixed(1)} s, ${(file.length / 1024).toFixed(0)} KB (quantizer: ${qps}); poster ${(poster.length / 1024).toFixed(0)} KB`;
}
