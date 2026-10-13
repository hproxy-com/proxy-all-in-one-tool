# HProxy: Proxy Connector and Checker (Chrome extension)

A Manifest V3 browser extension, and a proxy connector first (2026-10-12): it
connects your own proxies, and the free exits are the extra. Its popup: on
top the power button, the one control, as a VPN app has it (a blue arc runs
round it while it connects; on, blue floods the whole top from the button
out and one ring travels out from it), with the state in words and where
you appear under it; while connected, the checks of that connection as one line that
opens; then two places to connect to, each a list of rows you connect with
one click. (Until 1.0.3 a large card stood on top: the desktop app's
Connect card with the route through the H, the H itself a button.)

1. **My proxies**: paste any proxy line (every shape the desktop app reads,
   login included), and it is tested **in this browser** (only the test goes
   through it, your pages stay put), connected, checked by the analyzer, and
   saved for one-click reuse. The line and its login never leave the browser.
2. **Free**: tested free exits from the HProxy pool, by country, or Quick
   Connect for the fastest one anywhere. If an exit dies mid-browse it fails
   over to a fresh one and reports the dead one back so the pool heals.
   "New IP" rotates on demand.

"Your HProxy plans" (an HProxy account's paid proxies) is built but hidden
until "Sign in with HProxy" has its server route (`PLANS_LIVE` in `popup.js`).

The name has no "VPN" in it: it sets Chrome's proxy, which is not a VPN, and
the stores review VPN products on a stricter lane.

It lives in **Hproxy-Software-Bundle-Core** (`chrome-extension/`) with the rest
of HProxy's software, since 2026-09-23 (one main folder for every kind of
software HProxy makes). Its history before that is in the HProxy monorepo, at
`hproxy-extension/`. The backend it talks to (`/api/vpn/*`, `/api/v1/*`) stays in
the monorepo: the paths to `hproxy-backend/...` and `hproxy-website/...` below
are in that (private) repository.

## Architecture

The **background service worker (`background.js`) is the brain.** It owns the
live session (which proxy is active, the failover counter, rotation history)
and mirrors it to `chrome.storage.local`, so the connection survives both the
popup closing and MV3 recycling the worker. The **popup (`popup.*`) is a thin
remote control** that reads status and sends connect/rotate/disconnect
messages. Never move session state into the popup.

Two connection modes inside the worker:

- `vpn` — free exits from `/api/vpn/pool` (the same ranking `/api/vpn/next`
  walks, 50 per request). **Every exit is tested before any page goes through
  it**: a PAC script sends only `https://probe.hproxy.com/...` through the
  candidate while everything else stays where it was (on the current exit, or
  direct), and the candidate passes only when Chrome accepted the real
  certificate. Exits that fail are skipped for 30 minutes. When a connected
  exit throws proxy or certificate errors, the worker first probes it (one
  blocked site is not a dead exit), then searches again; after 3 searches in a
  row that find nothing it stops and the badge turns amber.
- `pin` — a fixed proxy (a saved BYO proxy or a generated paid line), probed
  once after connecting so the popup can say whether anything answers. Never
  moved automatically. Authenticated proxies answer the 407 challenge from
  memory in `webRequest.onAuthRequired`; a refused login is never resent.

Why the test exists (measured 2026-09-23, 30 exits in Quick Connect order, in
Chrome for Testing): 2 worked, 25 re-signed HTTPS with a forged certificate,
3 refused HTTPS. The engine calls all of them alive because its own check
accepts any certificate. Details:
`docs/plan-2026-09-19-publish-checker-and-extension/PLAN.md`.

While connected, WebRTC is locked to the proxy (`privacy` permission) and
released on disconnect. On every worker start the stored session and Chrome's
actual proxy setting are made to agree, so the popup never says Connected
while traffic goes direct.

The worker bypasses `hproxy.com` in the proxy config so its own control-plane
calls always go direct — that's what lets a heal fetch fresh exits even while
the current proxy is dead.

## Testing

```bash
node --test tests/*.test.mjs                 # parser + analyzer grading (build.ps1 runs these)
node tests/e2e/real-browser.mjs --shots=<dir> # the real extension in Chrome for Testing, end to end
node tests/e2e/free-pool-health.mjs --count=30 --json=<file>  # how many pool exits work in Chrome
```

The e2e run starts Chrome for Testing (from the puppeteer cache, or
`CHROME_PATH`) with a throwaway profile, never the installed Chrome. It drives
the worker through its real message router, connects to the live free pool,
kills exits to force failover, and runs two small proxies of its own on
127.0.0.1 for the login checks. It reports nothing to `/api/vpn/report`.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest, permissions, action/popup wiring |
| `background.js` | Service worker: session, proxy plumbing, failover, auth |
| `popup.html/css/js` | Popup UI (light only; the site's white Electric theme) |
| `tokens.css` | **GENERATED.** Every colour, copied from the website. Never edit |
| `scripts/sync-tokens.mjs` | Writes `tokens.css` from `hproxy-website/app/globals.css` |
| `scripts/verify-design.mjs` | Fails the build on any off-system colour, dead token, off-ruler size or see-through fill |
| `flags/` | 271 country flags: the SVGs (flag-icons 7.5.0, MIT, `flags/LICENSE`) are the source, the 66x48 PNGs are what ships (259 KB instead of 2.0 MB) |
| `scripts/rasterize-flags.mjs` | Draws `flags/*.png` from `flags/*.svg`; `--check` fails the build on a stale PNG |
| `tests/e2e/` | The real-browser run, the free-pool health check, the CDP client and the test proxy |
| `fonts/` | Inter variable font, latin (the computer app's font; `Inter-OFL.txt` is its licence) |
| `scripts/popup-states.mjs` | Draws every state of the popup in Chrome for Testing, for a look before a release |
| `scripts/store-shots.mjs` | The Chrome Web Store pictures, from the real popup |
| `icons/` | Toolbar icons (16/48/128) |

## Backend endpoints it depends on (all live in the Rust brain)

| Extension call | Served by |
|----------------|-----------|
| `GET /api/vpn/pool`, `/countries`, `POST /report` (`/next` exists, no longer called) | `hproxy-backend/src/free_proxy_core/http_api/vpn_extension_api.rs` |
| `GET https://probe.hproxy.com/api/free-proxy/echo` (through the tunnel: the exit test) | the brain's echo, behind Cloudflare |
| `GET /api/v1/plans` | `hproxy-backend/src/routes/v1_api.rs` (keyed, `require_v1` "buy") |
| `POST /api/v1/plans/:id/generate` | `hproxy-backend/src/routes/v1_keyed.rs` (keyed, "buy") |

> **Auth doors, don't mix them up.** `/v1/*` authenticates via the NextAuth
> session cookie (the `AuthUser` extractor in `auth/session.rs`) and ignores
> `X-API-Key` — it's the website dashboard's door. `/api/v1/*` authenticates via
> `X-API-Key: hpx_…` through `require_v1` — it's the programmatic/reseller door.
> The extension holds a key, so it MUST use `/api/v1/*`. (An earlier version
> called `/v1/plans` with a key header, which could never authenticate.)

`API` base is `https://hproxy.com` (see the `API` const in `background.js` and
`popup.js`). `/api/vpn/pool` exists but the popup doesn't use it yet — it could
back a richer favorites/rotation view later.

## ⚠️ Deploy requirement: `EXTENSION_IDS`

Sign-in **fails closed**. `GET /extension/connect` mints an API key and redirects
it to `https://<ext>.chromiumapp.org/`, so it refuses any extension id that is
not on an explicit allowlist. Without the allowlist, a malicious extension could
send a signed-in customer to `/extension/connect?ext=<its own id>` and receive a
working key for that account.

So the backend `.env` needs, before sign-in works at all:

```
EXTENSION_IDS=<the 32-char extension id>,<second id if any>
```

Find the id at `chrome://extensions` with Developer mode on. An **unpacked**
extension's id is derived from its folder path, so it differs per machine and
changes if the folder moves. Pin it by adding a `key` field to `manifest.json`
before publishing, or the store id will differ from every dev id.

If `EXTENSION_IDS` is unset the endpoint answers 403 to everyone, which is the
correct behaviour for a misconfigured credential minter and is asserted by
`routes::extension::tests::an_unusable_allowlist_authorises_nobody`.

## Permissions (and why)

- `proxy` — set Chrome's proxy settings.
- `storage` — persist the session, favorites, saved BYO proxies, and API key.
- `webRequest` + `webRequestAuthProvider` — detect proxy failures for failover
  and answer proxy (407) auth challenges. Only `onErrorOccurred` and
  `onAuthRequired` are listened to; there is no `onCompleted`, so the worker is
  not woken for every successful request in the browser.
- `privacy` — lock WebRTC to the proxy while connected, release it on
  disconnect.
- `identity` — "Sign in with HProxy" (`launchWebAuthFlow`).
- `host_permissions: <all_urls>` — required for the webRequest listeners to see
  traffic on every site and to proxy every site. Inherent to a proxy/VPN
  extension; expect the "read and change all your data" install warning.

## Design

The popup is a faithful small-screen sibling of the website, built to
`hproxy-website/DESIGN.md` in the monorepo (the agent-facing rules) and the `/design` book:

- **Tokens are GENERATED, not copied** (2026-08-02). `popup.css` declares no
  colours at all. `tokens.css` is written by `scripts/sync-tokens.mjs` from
  `hproxy-website/app/globals.css`, and `build.ps1` regenerates and verifies it
  before packaging, so a zip cannot be built with a stale palette.

  This replaced a hand-typed copy of the palette, and the reason is a bug that
  actually shipped: on 2026-07-31 the website retuned its three status colours
  for WCAG AA, the copy here kept the old ones, and the popup went out with
  `--ok` at **3.37:1**, `--warn` at **2.35:1** and `--bad` at **3.91:1** on
  white. The text floor is 4.5:1, and all three were values the website's own
  audit had already condemned. Nobody was careless. The value simply had to be
  retyped to be corrected, and retyping is not a mechanism.

  Practical rules that fall out of it:
  - **No hex literals in `popup.css`.** Pure white is the only exception, since
    white is the absence of a brand decision and the popup cannot theme.
  - **No hand-typed `rgba()` triples.** `rgba(1, 88, 255, 0.45)` is the same
    copy in disguise. Use `rgba(var(--digi-night-rgb), 0.45)`; every brand and
    status token ships an `-rgb` companion for exactly this. Only lines and
    shadows take one: a fill is never see-through (the house rule since
    2026-09-26, enforced by `verify-design.mjs`).
  - **Need a new colour? Add it to the website's globals.css.** That is the
    only door, deliberately.
  - Off-ruler font sizes need `ruler-exempt: <why>` on the line. Three exist
    today, all logotype or glyph sizing, and the verifier reports them.

- **The computer app's look** (2026-10-12): words and hairlines instead of
  cards, one solid blue for what is chosen or on, the H's corners on what you
  press. A row (a saved proxy, a country, the fastest free proxy) is its name
  and a second line at rest; pointed at, it shows Connect (and a saved one its
  ×, a country its star); the one in use has the H's crossbar on its left and
  says Connected in green. Amber is the warning colour (a login refused, no
  answer yet), green and red status only, never a surface.
- **Light only, on purpose** (decided 2026-07-23). The popup is always the white
  Electric theme regardless of the OS scheme. `color-scheme: light` on `:root`
  plus the `<meta name="color-scheme" content="light">` tag stop a dark-OS
  browser from dark-ifying the inputs and scrollbar. No `prefers-color-scheme`
  block exists; do not re-add one.
- **The type ruler.** Sizes come from the ruler (10, 11, 12, 13, 13.5 and
  15 px; `verify-design.mjs` holds the list). Inter only, the computer app's
  font (`fonts/Inter-Variable-latin.woff2`; DM Sans until 1.0.3). The address
  you appear on is plain text with kerning off: when it changes its digits
  roll over and land exactly where the plain text puts them, then it is plain
  text again (`motion.js` rollDigits, the app's Roll.tsx).
- **Grammars borrowed from the computer app.** The tabs are words on a
  hairline with the H's crossbar under the current one, sliding to the next;
  inputs and buttons have the H's corners. No emoji, no icon tiles: an icon
  stands alone.
- **The power button's moves are all CSS** (`popup.css`, "THE POWER
  BUTTON"), driven by `data-phase` and `data-failing` on `#conn`, which
  `popup.js` sets. The blue is solid at every moment, uncovered by a circle
  growing out of the button (and the button's mark turns blue under a
  circle of its own, never faded); only the travelling ring, a line, fades.
  The moves are recorded with `scripts/power-video.mjs`.

Every state of the popup, drawn in Chrome for Testing (never the browser in
use): `node scripts/popup-states.mjs <folder>` (not connected, a hover, your
own proxy connected with its checks open, Free, a login refused, a proxy that
does not answer, a first-time user; `--free` adds a live free exit). The store's
three pictures: `node scripts/store-shots.mjs <folder>`. Both swap every
address on screen for an example one.

## Develop / load unpacked

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Edit files, then hit the reload icon on the extension card. Changes to the
   popup show on reopen; changes to `background.js` need the reload.

## Package for the Chrome Web Store

```powershell
pwsh ./build.ps1
```

Produces `dist/hproxy-extension-v<version>.zip` with `manifest.json` at the zip
root, containing only runtime assets. Upload it in the Chrome Web Store
developer console.

## Removed bandaid (2026-07-22)

(History: since 1.0 the extension does not call `/api/free-proxy/check` at all.
A pasted proxy is tested in the browser, background.js `pinFind`.)


`rules.json` used to rewrite the request `Origin` to `https://hproxy.com` so
the BYO "Test" call could pass `/api/free-proxy/check`'s origin check. The
backend now serves open CORS on that route (verified live against production:
preflight and POST both answer `access-control-allow-origin: *`), so the rule
file and the `declarativeNetRequestWithHostAccess` permission were deleted in
v0.2.1. One less permission in the install warning.
(Note: `<all_urls>` stays regardless — the proxy failover/auth listeners need it.)

**"Your HProxy plans": CORS is live, sign-in is not.** `/api/v1/plans` answers
the extension's preflight with `204` and `access-control-allow-origin: *`
(verified 2026-09-23; it was a 405 on 2026-07-22). What still blocks the
section is the sign-in route: `GET https://hproxy.com/extension/connect`
answers 404 because `hproxy-backend/src/routes/extension.rs` is not declared
in `routes/mod.rs`. Until that is mounted (a backend auth change, not decided
yet), the "Sign in with HProxy" button opens a 404 page.

## Roadmap

- [x] Home into the monorepo
- [x] Light-only popup, locked to the site's white Electric theme (v0.3.1)
- [x] Drop the Origin-rewrite bandaid (backend went CORS-open; removed in v0.2.1)
- [ ] Website → extension bridge: one-click Connect from the free-proxy-list pages
- [ ] CORS on `/api/v1/*` for extension origins ("My proxies" is blocked on this)
- [ ] Account login (OAuth) so "My proxies" uses the session instead of an API key
- [ ] Per-site / per-tab proxy rules, kill switch, WebRTC leak-protection toggle

## Marketing

The site's `/extension` page is currently a "Coming Soon" placeholder. The rich
landing (`hproxy-website/components/extension/ExtensionHero.tsx` +
`ExtensionSteps.tsx`) is built but not imported. Note the landing promises a
"sign in once" flow and shows Residential/Mobile/ISP tabs — that matches the
planned OAuth work, not the current API-key popup, so re-enable it after Pass 2.
