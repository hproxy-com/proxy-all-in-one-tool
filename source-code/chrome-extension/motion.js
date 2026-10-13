/* ============================================================
   MOTION: the computer app's moves, made for the popup (1.0.3).

   The same language as desktop-app/src (Track D, 2026-10-10/11):

     slideIn      a page comes in from the side of the tab pressed
                  (lib/motion.ts).
     riseIn       a new line of words rises in from behind its own
                  bottom edge, the way the app's address pill takes
                  a new state.
     rollDigits   an address whose digits turn over like a counter,
                  each a wheel of 0 to 9, plain text again once it
                  lands (components/ui/Roll.tsx).

   The tabs' crossbar, which slides to the tab pressed, is CSS and
   lives with the tabs (popup.js, placeBar). Until 1.0.3 the tabs
   were a track with a sliding blue pill made here.

   Nothing fades: things move (transform) or are uncovered
   (clip-path), so nothing is see-through for a moment either.
   The quiet setting of the system (reduced motion) keeps all of
   it still: everything lands in its place at once.
   ============================================================ */

export const GLIDE = "cubic-bezier(0.2, 0.9, 0.1, 1)";

export function quiet() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ── A page from the side, a line from below ──────────────────────────── */

/** A page comes in from `from` ("left" or "right"), on the Glide curve. */
export function slideIn(node, from) {
  if (!node || typeof node.animate !== "function" || quiet()) return;
  const shift = from === "right" ? "translateX(44px)" : "translateX(-44px)";
  node.animate([{ transform: shift }, { transform: "none" }], { duration: 520, easing: GLIDE });
}

/**
 * A new line of words rises in from behind its own bottom edge: it starts one
 * line down and clipped at the box's foot, so only what is already inside the
 * box shows while it rises.
 */
export function riseIn(node, ms = 460) {
  if (!node || typeof node.animate !== "function" || quiet()) return;
  node.getAnimations().forEach((a) => a.cancel());
  node.animate(
    [
      { transform: "translateY(100%)", clipPath: "inset(0 0 100% 0)" },
      { transform: "none", clipPath: "inset(0 0 0 0)" },
    ],
    { duration: ms, easing: GLIDE },
  );
}

/**
 * A block opens downward, its height growing from nothing, or folds back up
 * and is hidden; what is under it moves with it instead of jumping. Its
 * content is uncovered by its own edge (overflow: clip), never faded in.
 */
export function unfold(node, open, ms = 340) {
  if (!node) return;
  node.getAnimations().forEach((a) => a.cancel());
  if (quiet() || typeof node.animate !== "function") {
    node.hidden = !open;
    return;
  }
  node.hidden = false;
  const full = `${node.scrollHeight}px`;
  const move = node.animate(
    [
      { height: open ? "0px" : full, overflow: "clip" },
      { height: open ? full : "0px", overflow: "clip" },
    ],
    { duration: open ? ms : Math.round(ms * 0.75), easing: GLIDE },
  );
  if (!open) move.onfinish = () => (node.hidden = true);
}

/* ── Rolling digits ───────────────────────────────────────────────────── */

/* A wheel is the ten digits twice over (Roll.tsx): it rests on the first ten. */
const WHEEL = "01234567890123456789";
const CELL = 100 / WHEEL.length;
const at = (cell) => `translateY(${-cell * CELL}%)`;
const ROLL_MS = 620;
/* A turning address's way back to plain text, once its wheels have landed. */
const settling = new WeakMap();

function wheel(d) {
  const digit = document.createElement("span");
  digit.className = "digit";
  digit.setAttribute("aria-hidden", "true");
  const size = document.createElement("span");
  size.className = "size";
  size.textContent = String(d);
  const strip = document.createElement("span");
  strip.className = "strip";
  strip.style.transform = at(d);
  for (const n of WHEEL) {
    const cell = document.createElement("span");
    cell.textContent = n;
    strip.append(cell);
  }
  digit.append(size, strip);
  return digit;
}

/**
 * Write `text` into `node`, its digits turning over like a counter. A digit
 * that changed turns straight to its new value; one that was not there turns
 * up from 0. At rest the address is plain text: the wheels exist only while
 * it turns (Roll.tsx, 2026-10-12: a resting wheel sat half a pixel off its
 * neighbours, and the digits looked jumbled). The first writing, and the
 * quiet setting, write plain text at once.
 */
export function rollDigits(node, text) {
  if (!node) return;
  const before = node.dataset.text ?? null;
  if (before === text) return;
  node.dataset.text = text;
  clearTimeout(settling.get(node));
  const rest = () => {
    node.classList.remove("digits");
    node.removeAttribute("aria-label");
    node.textContent = text;
  };
  if (before === null || quiet() || typeof node.animate !== "function") return rest();
  node.setAttribute("aria-label", text);
  node.classList.add("digits");
  const old = [...before];
  settling.set(node, setTimeout(rest, ROLL_MS + 40));
  node.replaceChildren(
    ...[...text].map((c, i) => {
      if (!/\d/.test(c)) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = c;
        return sep;
      }
      const d = Number(c);
      const w = wheel(d);
      const was = /\d/.test(old[i] ?? "") ? Number(old[i]) : 0;
      const strip = w.lastChild;
      if (was !== d) strip.animate([{ transform: at(was) }, { transform: at(d) }], { duration: ROLL_MS, easing: GLIDE });
      return w;
    }),
  );
}
