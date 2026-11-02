// tray-icons.mjs: the three icons by the clock, from the app's own H. Run from desktop-app/:
//   node scripts/tray-icons.mjs
//
// The H keeps its shape and its soft edges; only its colour says how things stand: grey not
// connected, blue connected, red a proxy that stopped answering. Solid colours on transparency,
// the way the app's own icon is the H alone. tray.rs builds them in with include_image!. The same
// H, larger, stands beside the words of a notification (notify.rs).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png.mjs";

const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
const small = decodePng(readFileSync(join(ICONS, "64x64.png")));
const large = decodePng(readFileSync(join(ICONS, "128x128.png")));
if (small.channels !== 4 || large.channels !== 4) throw new Error("the H needs its transparency");

const LOOKS = {
  "tray-off.png": [small, 0x8b, 0x91, 0xa0],
  "tray-on.png": [small, 0x01, 0x58, 0xff],
  "tray-stopped.png": [small, 0xe5, 0x39, 0x35],
  "notify-on.png": [large, 0x01, 0x58, 0xff],
  "notify-stopped.png": [large, 0xc6, 0x28, 0x28],
};

for (const [name, [source, r, g, b]] of Object.entries(LOOKS)) {
  const pixels = Buffer.from(source.pixels);
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = r;
    pixels[at + 1] = g;
    pixels[at + 2] = b;
  }
  writeFileSync(join(ICONS, name), encodePng({ width: source.width, height: source.height, channels: 4, pixels }));
  console.log(name);
}
