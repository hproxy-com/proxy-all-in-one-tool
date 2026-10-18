/* The stage's player (film.html): the worker the popup talks to, the words, the badge, the
   pointer and the popup's frame. The recorder (scripts/marketing-video.mjs) puts its clock into
   this page and into the popup's before their own code, and moves both; every timer here runs on
   that clock. */

(() => {
  const $ = (id) => document.getElementById(id);
  const frame = $("popup");

  /* ---------- the worker ----------
     background.js's answers, in the order it gives them. Your own proxy: set at once with the
     badge on, then tested; what comes back says the exit (0.3 s, then 1.2 s). A free one: the
     search runs while the connection there is keeps going, until an exit passes (1.6 s). The
     popup's own requests are answered by the recorder. */
  const state = { active: null, searching: false, testing: false };
  const listeners = new Set();
  const changed = () => {
    for (const fn of [...listeners]) {
      try {
        fn({ type: "statusChanged" });
      } catch {
        listeners.delete(fn);
      }
    }
    $("badge").hidden = !state.active;
  };
  const session = (extra) => ({
    failing: false,
    rechecking: false,
    loginRefused: false,
    hijacked: false,
    policy: false,
    ...extra,
  });
  // The free exit of each country the film goes to.
  const FREE = { US: "192.0.2.148" };

  window.__worker = {
    listen: (fn) => listeners.add(fn),
    handle(msg, cb) {
      const answer = (value) => setTimeout(() => cb && cb(value), 0);
      switch (msg && msg.type) {
        case "status":
          return answer({ ok: true, active: state.active, searching: state.searching, testing: state.testing });
        case "pinConnect": {
          const p = msg.proxy || {};
          state.testing = true;
          setTimeout(() => {
            state.active = session({
              mode: "pin",
              scheme: p.scheme || "http",
              host: p.host,
              port: p.port,
              label: msg.label,
              exitIp: msg.exitIp || p.host,
              country: msg.country || "",
              auth: !!p.username,
              verified: null,
            });
            changed();
          }, 300);
          setTimeout(() => {
            state.active = { ...state.active, verified: true };
            state.testing = false;
            changed();
            if (cb) cb({ ok: true, active: state.active });
          }, 1200);
          return;
        }
        case "vpnConnect": {
          const cc = String(msg.country || "US").toUpperCase();
          state.searching = true;
          changed();
          setTimeout(() => {
            const ip = FREE[cc] || FREE.US;
            state.active = session({ mode: "vpn", scheme: "socks5", host: ip, port: 1080, label: cc, exitIp: ip, country: cc, auth: false, verified: true });
            state.searching = false;
            changed();
            if (cb) cb({ ok: true, active: state.active });
          }, 1600);
          return;
        }
        case "disconnect":
          state.active = null;
          state.searching = false;
          state.testing = false;
          changed();
          return answer({ ok: true, active: null });
        default:
          return answer({ ok: true });
      }
    },
  };

  /* ---------- the words ----------
     One line at a time: the next rises in from below while the last one leaves upward. */
  const SAY = [
    {
      h: "Your proxies, one click away.",
      p: "Paste a proxy once, in any format. It is tested in your browser, kept, and connected with one click.",
    },
    { h: 'Sites now see <span class="ip">203.0.113.24</span>', p: "Every tab goes through your own proxy, in the United States." },
    {
      h: "Seven checks, all clear.",
      p: "Exit address, header leaks, DNS, WebRTC, time zone, language and the round trip, on every connect.",
    },
    { h: "No proxy yet? Take a free one.", p: "Free proxies by country, each one tested here before a page goes through it." },
    { h: 'Sites now see <span class="ip">192.0.2.148</span>', p: "A free proxy in the United States, tested before it was used." },
  ];
  let shown = null;
  function say(i, still = false) {
    const line = document.createElement("div");
    line.className = still ? "line" : "line below";
    line.innerHTML = `<h1>${SAY[i].h}</h1><p>${SAY[i].p}</p>`;
    $("say").append(line);
    const old = shown;
    shown = line;
    if (old) {
      if (still) old.remove();
      else {
        old.classList.add("gone");
        setTimeout(() => old.remove(), 700);
      }
    }
    if (!still) {
      void line.offsetWidth;
      line.classList.remove("below");
    }
  }

  /* ---------- the popup ---------- */
  // As Chrome sizes a popup: as tall as its page, 600 px at most (then the page scrolls).
  function fit() {
    const body = frame.contentDocument && frame.contentDocument.body;
    if (!body) return;
    const h = Math.min(600, Math.ceil(body.getBoundingClientRect().height));
    if (h > 0 && frame.style.height !== `${h}px`) frame.style.height = `${h}px`;
  }
  function open(on) {
    $("popupBox").classList.toggle("open", on);
    $("ext").classList.toggle("open", on);
  }
  // The popup's page, loaded into its frame while the frame is still closed.
  const load = () =>
    new Promise((done) => {
      frame.addEventListener("load", () => done(true), { once: true });
      frame.src = "popup.html";
    });
  // The middle of the first element matching `sel` in the popup, on this page; null when none.
  function inPopup(sel) {
    const el = frame.contentDocument && frame.contentDocument.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2, top: f.top + r.top, bottom: f.top + r.bottom };
  }
  const popupText = (sel) => {
    const el = frame.contentDocument && frame.contentDocument.querySelector(sel);
    return el ? el.textContent.trim() : null;
  };
  const popupAttr = (sel, name) => {
    const el = frame.contentDocument && frame.contentDocument.querySelector(sel);
    return el ? el.getAttribute(name) : null;
  };

  /* ---------- the pointer ---------- */
  function pointer(x, y, pressed, r, a) {
    $("arrow").style.transform = `translate(${x - 6}px, ${y - 4}px) scale(${pressed ? 0.86 : 1})`;
    const ring = $("ring");
    ring.style.width = ring.style.height = `${2 * r}px`;
    ring.style.transform = `translate(${x - r}px, ${y - r}px)`;
    ring.style.opacity = String(a);
  }

  /* ---------- the clock, of both pages ---------- */
  async function step(ms) {
    await window.__clock.step(ms);
    const inner = frame.contentWindow;
    if (inner && inner.__clock) await inner.__clock.step(ms);
    fit();
  }
  const errors = () => {
    const inner = frame.contentWindow && frame.contentWindow.__clock;
    return [...window.__clock.errors, ...(inner ? inner.errors : [])];
  };

  window.__stage = { state, say, open, load, fit, inPopup, popupText, popupAttr, pointer, step, errors };
})();
