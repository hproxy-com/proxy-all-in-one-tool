// msix.mjs: the Microsoft Store package (MSIX) of the app, from the release build.
// Run from desktop-app/, after `npx tauri build --no-bundle`:
//
//   node scripts/msix.mjs              the package: ../target/msix/HProxy_<version>_x64.msix
//   node scripts/msix.mjs --register   also install the unpacked package on this PC, to try it
//                                      before an upload (needs Windows' Developer Mode)
//   node scripts/msix.mjs --unregister take that trial install off again
//
// The package is the release program (the frontend is inside it), the blue-H icons that
// scripts/app-icons.mjs draws, and store/microsoft-store/msix/AppxManifest.xml with this build's
// version. It is not signed here: the Microsoft Store signs what it publishes. The Store
// wants four numbers with the last one 0, so version 0.2.3 is packed as 0.2.3.0.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(APP, "..");
const PROGRAM = join(ROOT, "target", "release", "hproxy-checker.exe");
const ICONS = join(APP, "src-tauri", "icons");
const MANIFEST = join(APP, "store", "microsoft-store", "msix", "AppxManifest.xml");
const OUT = join(ROOT, "target", "msix");
const LAYOUT = join(OUT, "layout");
// No large (310 x 310) tile: Windows then wants a wide 310 x 150 one too, and the H has none.
const ASSETS = ["StoreLogo.png", "Square44x44Logo.png", "Square71x71Logo.png", "Square150x150Logo.png"];
/* The taskbar's and Start's own sizes, each also "without a plate" (2026-10-22: the blue H sat on a
   pink plate in the taskbar). With only Square44x44Logo.png,
   Windows drew the H on a plate in the person's accent colour (the manifest's BackgroundColor is
   "transparent"); `_altform-unplated` (dark taskbar) and `_altform-lightunplated` (light taskbar)
   say "this size, no plate", and resources.pri (makepri, below) tells Windows these files exist.
   Drawn at pack time from the H's vector master, icons/source/desktop.svg (scripts/app-icons.mjs). */
const TARGET_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];
const TARGET_VARIANTS = ["", "_altform-unplated", "_altform-lightunplated"];
const PACKAGE_NAME = "HProxy.HProxyProxyConnectorandChecker";

const args = process.argv.slice(2);

function powershell(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }).trim();
}

if (args.includes("--unregister")) {
  const found = powershell(`(Get-AppxPackage -Name '${PACKAGE_NAME}').PackageFullName`);
  if (!found) {
    console.log("no trial install of the package on this PC");
    process.exit(0);
  }
  powershell(`Remove-AppxPackage -Package '${found}'`);
  console.log(`removed ${found}`);
  process.exit(0);
}

/** A tool (makeappx.exe, makepri.exe) from the newest Windows SDK on this PC that has it. */
function sdkTool(name) {
  const base = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = existsSync(base) ? readdirSync(base).filter((v) => /^10\.\d+\.\d+\.\d+$/.test(v)) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const v of versions.reverse()) {
    const tool = join(base, v, "x64", name);
    if (existsSync(tool)) return tool;
  }
  throw new Error(`${name} not found: install the Windows SDK (its App Certification Kit part)`);
}

/** Runs an SDK tool; on a refusal, the lines where it says why. */
function runSdk(name, toolArgs) {
  try {
    execFileSync(sdkTool(name), toolArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // The tools say why on stdout ("App manifest validation error: Line 64 ...").
    const said = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => /error/i.test(l));
    throw new Error(`${name} refused:\n${said.join("\n")}`);
  }
}

if (!existsSync(PROGRAM)) throw new Error(`no release build at ${PROGRAM}: run \`npx tauri build --no-bundle\` first`);
const conf = JSON.parse(readFileSync(join(APP, "src-tauri", "tauri.conf.json"), "utf8"));
const version = `${conf.version}.0`;
if (!/^\d+\.\d+\.\d+\.0$/.test(version)) throw new Error(`the version ${conf.version} does not make a Store version`);

rmSync(LAYOUT, { recursive: true, force: true });
mkdirSync(join(LAYOUT, "Assets"), { recursive: true });
copyFileSync(PROGRAM, join(LAYOUT, "hproxy-checker.exe"));
for (const name of ASSETS) copyFileSync(join(ICONS, name), join(LAYOUT, "Assets", name));
const drawn = mkdtempSync(join(tmpdir(), "hproxy-msix-icons-"));
try {
  const sizes = TARGET_SIZES.flatMap((s) => ["--png", String(s)]);
  execFileSync("npx", ["tauri", "icon", join(ICONS, "source", "desktop.svg"), "-o", drawn, ...sizes], {
    cwd: APP,
    stdio: ["ignore", "ignore", "pipe"],
    shell: true,
  });
  for (const s of TARGET_SIZES) {
    for (const variant of TARGET_VARIANTS) {
      copyFileSync(join(drawn, `${s}x${s}.png`), join(LAYOUT, "Assets", `Square44x44Logo.targetsize-${s}${variant}.png`));
    }
  }
} finally {
  rmSync(drawn, { recursive: true, force: true });
}
writeFileSync(join(LAYOUT, "AppxManifest.xml"), readFileSync(MANIFEST, "utf8").replace("{VERSION}", version));

// The index of the package's files by size and form, without which Windows never looks for the
// taskbar sizes above.
const priConfig = join(OUT, "priconfig.xml");
runSdk("makepri.exe", ["createconfig", "/cf", priConfig, "/dq", "en-US", "/pv", "10.0.0", "/o"]);
runSdk("makepri.exe", ["new", "/pr", LAYOUT, "/cf", priConfig, "/mn", join(LAYOUT, "AppxManifest.xml"), "/of", join(LAYOUT, "resources.pri"), "/o"]);

const msix = join(OUT, `HProxy_${version}_x64.msix`);
runSdk("makeappx.exe", ["pack", "/d", LAYOUT, "/p", msix, "/o"]);
console.log(`${msix} (${(statSync(msix).size / 1048576).toFixed(1)} MB, version ${version})`);

if (args.includes("--register")) {
  const previous = powershell(`(Get-AppxPackage -Name '${PACKAGE_NAME}').PackageFullName`);
  if (previous) powershell(`Remove-AppxPackage -Package '${previous}'`);
  powershell(`Add-AppxPackage -Register '${join(LAYOUT, "AppxManifest.xml")}'`);
  console.log(`registered on this PC: ${powershell(`(Get-AppxPackage -Name '${PACKAGE_NAME}').PackageFullName`)}`);
}
