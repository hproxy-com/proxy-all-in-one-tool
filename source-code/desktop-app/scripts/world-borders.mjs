// Makes src/components/connect/mix/world-borders.json: every country's border at
// Natural Earth's 1:50m detail, for the Mix map once it is close (worldMap.ts). The
// map's own land (world-land.json, about 33,000 points) is cut for the world view; a
// close-up over Europe needs finer borders (France 817 points instead of 66).
//
// Input: Natural Earth 1:50m admin-0 countries, public domain
// (https://www.naturalearthdata.com). Not kept in the repo; download it once:
//
//   curl -L -o ne_50m_countries.geojson \
//     https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
//   node scripts/world-borders.mjs ne_50m_countries.geojson
//
// The same format as world-land.json: per country code, its rings, each one string in
// the encoded polyline format (two signed numbers per point, longitude then latitude, in
// hundredths of a degree, each as the difference to the point before). Holes stay rings
// of their own (Lesotho inside South Africa), so even-odd filling leaves them out.
// Antarctica is left out (the map ends before it). The three places without a code
// (Somaliland, Northern Cyprus, Siachen) are kept as land under "_" + their Natural
// Earth code, so they are drawn but never lit.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/world-borders.mjs <ne_50m_admin_0_countries.geojson>");
  process.exit(2);
}
const features = JSON.parse(readFileSync(input, "utf8")).features;

/** ISO_A2, or Natural Earth's fallback where ISO_A2 is -99 (France, Norway, Kosovo). */
function codeOf(p) {
  for (const c of [p.ISO_A2, p.ISO_A2_EH]) if (typeof c === "string" && /^[A-Z]{2}$/.test(c)) return c.toLowerCase();
  return null;
}

function encodeSigned(v) {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let out = "";
  while (n >= 0x20) {
    out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return out + String.fromCharCode(n + 63);
}

const out = {};
let points = 0;
let rings = 0;
for (const f of features) {
  const p = f.properties;
  const cc = codeOf(p) ?? `_${String(p.ADM0_A3).toLowerCase()}`;
  if (cc === "aq") continue;
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const list = (out[cc] ??= []);
  for (const poly of polys) {
    for (const ring of poly) {
      const pts = [];
      for (const [lng, lat] of ring) {
        const q = [Math.round(lng * 100), Math.round(lat * 100)];
        const last = pts[pts.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
      }
      // GeoJSON closes a ring with its first point again; the map closes it itself.
      const a = pts[0];
      const z = pts[pts.length - 1];
      if (pts.length > 1 && a[0] === z[0] && a[1] === z[1]) pts.pop();
      if (pts.length < 3) continue;
      let s = "";
      let [px, py] = [0, 0];
      for (const [x, y] of pts) {
        s += encodeSigned(x - px) + encodeSigned(y - py);
        [px, py] = [x, y];
      }
      list.push(s);
      points += pts.length;
      rings++;
    }
  }
  if (!list.length) delete out[cc];
}

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "src", "components", "connect", "mix", "world-borders.json");
const text = JSON.stringify(out);
writeFileSync(file, text);
console.log(file, Object.keys(out).length, "countries", rings, "rings", points, "points", text.length, "bytes");
