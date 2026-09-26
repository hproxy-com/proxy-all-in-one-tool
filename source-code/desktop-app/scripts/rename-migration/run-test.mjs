// The rename, played on this PC with two throwaway products (2026-09-24). Proves that installing
// "HProxy" over "hproxy-checker" removes the old install and keeps what matters, before any real
// install depends on it. Everything here is named hproxy-migtest-* (its own product names, its own
// identifier com.hproxy.migtest, its own program hproxy-migtest.exe), so the real app is never
// touched: Tauri's installer closes running copies by program name. Cleans up after itself.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The installers build.sh made (builds/migration-test at the repo's root).
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../builds/migration-test");
const OLD = "hproxy-migtest-old";
const NEW = "hproxy-migtest-new";
const BIN = "hproxy-migtest.exe";
const ID = "com.hproxy.migtest";
const LOCAL = process.env.LOCALAPPDATA;
const ROAMING = process.env.APPDATA;
const DESKTOP = spawnSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" }).stdout.trim();
const START_MENU = join(ROAMING, "Microsoft", "Windows", "Start Menu", "Programs");
const UNINST = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const reg = (...args) => spawnSync("reg", args, { encoding: "utf8" });
/* The user's PATH as saved: unexpanded, because Windows keeps %VARIABLES% in it. Written back
   the same way, the value passed through an environment variable, never the command line. */
const psPath = "[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'";
const userPath = () =>
  spawnSync("powershell", ["-NoProfile", "-Command", `${psPath}).GetValue('Path', '', 'DoNotExpandEnvironmentNames')`], { encoding: "utf8" }).stdout.replace(/\r?\n$/, "");
const setUserPath = (value) =>
  spawnSync("powershell", ["-NoProfile", "-Command", `${psPath}, $true).SetValue('Path', $env:HPROXY_TEST_PATH, 'ExpandString')`], {
    env: { ...process.env, HPROXY_TEST_PATH: value },
  });
const ENV_BACKUP = join(DIR, "environment-backup.reg");
const hasKey = (key) => reg("query", key).status === 0;
const regValue = (key, value) => (reg("query", key, "/v", value).stdout.match(/REG_SZ\s+(.*)/) || [])[1]?.trim() ?? null;
const run = (exe, args) => spawnSync(exe, args, { encoding: "utf8", timeout: 240_000 }).status;
const setup = (product) => join(DIR, readFileSyncDir(product));
function readFileSyncDir(product) {
  const name = spawnSync("cmd", ["/c", "dir", "/b", `${DIR.replace(/\//g, "\\")}\\${product}_*_x64-setup.exe`], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0];
  if (!name) throw new Error(`no installer for ${product} in ${DIR}`);
  return name;
}
function shortcut(path, target) {
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${path}');$s.TargetPath='${target}';$s.Save()`;
  spawnSync("powershell", ["-NoProfile", "-Command", ps]);
}

let failed = 0;
function expect(what, ok) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
}

function cleanUp() {
  for (const product of [NEW, OLD]) {
    const dir = join(LOCAL, product);
    if (existsSync(join(dir, "uninstall.exe"))) run(join(dir, "uninstall.exe"), ["/S", `_?=${dir}`]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(DESKTOP, `${product}.lnk`), { force: true });
    rmSync(join(START_MENU, `${product}.lnk`), { force: true });
    reg("delete", RUN, "/v", product, "/f");
    reg("delete", `${UNINST}\\${product}`, "/f");
    reg("delete", `HKCU\\Software\\hproxy\\${product}`, "/f");
    reg("delete", `HKCU\\Software\\HProxy\\${product}`, "/f");
  }
  rmSync(join(ROAMING, ID), { recursive: true, force: true });
  rmSync(join(LOCAL, ID), { recursive: true, force: true });
}

/* The old product installed, then the new one over it, run with `args`. Twice below: as a person
   runs a downloaded installer (/S), and as the app's updater runs it (/UPDATE, with its install
   mode; tauri-plugin-updater adds /UPDATE). In update mode Tauri's template creates no shortcut
   at all, so there the Start menu entry and the desktop shortcut come back only through the
   hook; the first version of the hook missed the Start menu entry that way. */
function migration(label, args) {
  console.log(`\n== ${label}: new installer ${args.join(" ")}`);
  // 1. The old product, as an earlier HProxy would be installed.
  expect(`old installer ran (${readFileSyncDir(OLD)})`, run(setup(OLD), ["/S"]) === 0);
  expect("old: Apps entry", hasKey(`${UNINST}\\${OLD}`));
  expect("old: program in its folder", existsSync(join(LOCAL, OLD, BIN)));
  expect("old: Start menu entry", existsSync(join(START_MENU, `${OLD}.lnk`)));

  // 2. What a person could have added: a desktop shortcut, start with the computer, and data.
  shortcut(join(DESKTOP, `${OLD}.lnk`), join(LOCAL, OLD, BIN));
  reg("add", RUN, "/v", OLD, "/t", "REG_SZ", "/d", `${join(LOCAL, OLD, BIN)} --background`, "/f");
  for (const base of [ROAMING, LOCAL]) {
    mkdirSync(join(base, ID), { recursive: true });
    writeFileSync(join(base, ID, "saved-lists.txt"), "kept across the rename");
  }
  expect("set up: desktop shortcut and start-with-computer entry", existsSync(join(DESKTOP, `${OLD}.lnk`)) && regValue(RUN, OLD) !== null);

  // 3. The new product installed over it.
  expect(`new installer ran (${readFileSyncDir(NEW)})`, run(setup(NEW), args) === 0);
  expect("old Apps entry gone", !hasKey(`${UNINST}\\${OLD}`));
  expect("old folder gone", !existsSync(join(LOCAL, OLD)));
  expect("old Start menu entry gone", !existsSync(join(START_MENU, `${OLD}.lnk`)));
  expect("old desktop shortcut gone", !existsSync(join(DESKTOP, `${OLD}.lnk`)));
  expect("old start-with-computer entry gone", regValue(RUN, OLD) === null);
  expect("new Apps entry", hasKey(`${UNINST}\\${NEW}`));
  expect("new program in its folder", existsSync(join(LOCAL, NEW, BIN)));
  expect("new Start menu entry", existsSync(join(START_MENU, `${NEW}.lnk`)));
  expect("desktop shortcut back under the new name", existsSync(join(DESKTOP, `${NEW}.lnk`)));
  const runValue = regValue(RUN, NEW);
  expect(`start-with-computer back under the new name (${runValue})`, runValue === `${join(LOCAL, NEW, BIN)} --background`);
  for (const base of [ROAMING, LOCAL]) {
    const file = join(base, ID, "saved-lists.txt");
    expect(`data kept: ${file}`, existsSync(file) && readFileSync(file, "utf8") === "kept across the rename");
  }
}

console.log(`desktop: ${DESKTOP}`);
// The user's environment is put back exactly as it is now, whatever happens below.
const ORIGINAL_PATH = userPath();
if (reg("export", "HKCU\\Environment", ENV_BACKUP.replace(/\//g, "\\"), "/y").status !== 0) throw new Error("could not back up HKCU\\Environment");
cleanUp();
try {
  migration("a person runs the new installer", ["/S"]);
  cleanUp();
  migration("the app's updater runs it", ["/S", "/UPDATE"]);

  // 4. An update over the new product (what the updater runs): nothing of it is lost.
  console.log("\n== an update over the new product");
  expect("update run (/S /UPDATE)", run(setup(NEW), ["/S", "/UPDATE"]) === 0);
  expect("after the update: Apps entry, program and Start menu entry", hasKey(`${UNINST}\\${NEW}`) && existsSync(join(LOCAL, NEW, BIN)) && existsSync(join(START_MENU, `${NEW}.lnk`)));

  // 5. Uninstalling takes the AI tool's folder off the user's PATH. The app puts it there
  // (src-tauri/src/tool.rs); here the test does, for the test product's own folder only.
  console.log("\n== uninstalling takes the tool's folder off the PATH");
  const toolDir = join(LOCAL, ID, "tool");
  const kept = ORIGINAL_PATH.replace(/;+$/, "");
  const onPath = () => userPath().split(";").some((e) => e.trim().replace(/\\$/, "").toLowerCase() === toolDir.toLowerCase());
  setUserPath(kept ? `${kept};${toolDir}` : toolDir);
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, "on-path.txt"), `${toolDir}\n`);
  expect("set up: the test product's tool folder is on the PATH", onPath());
  expect("uninstaller ran (/S)", run(join(LOCAL, NEW, "uninstall.exe"), ["/S", `_?=${join(LOCAL, NEW)}`]) === 0);
  expect("the tool folder is off the PATH", !onPath());
  expect("every other PATH entry is as it was", userPath() === kept);
  expect("the on-path note is gone", !existsSync(join(toolDir, "on-path.txt")));
} finally {
  cleanUp();
  if (existsSync(ENV_BACKUP)) {
    reg("import", ENV_BACKUP.replace(/\//g, "\\"));
    rmSync(ENV_BACKUP, { force: true });
  }
  expect("the user's PATH is exactly as before the test", userPath() === ORIGINAL_PATH);
  const leftovers = [join(LOCAL, OLD), join(LOCAL, NEW), join(DESKTOP, `${OLD}.lnk`), join(DESKTOP, `${NEW}.lnk`), join(START_MENU, `${OLD}.lnk`), join(START_MENU, `${NEW}.lnk`), join(ROAMING, ID), join(LOCAL, ID)].filter((p) => existsSync(p));
  const keys = [OLD, NEW].filter((p) => hasKey(`${UNINST}\\${p}`) || regValue(RUN, p) !== null);
  expect(`cleaned up (files left: ${leftovers.length}, registry left: ${keys.length})`, leftovers.length === 0 && keys.length === 0);
  // The real app's own records were never in play.
  expect("the real hproxy-checker install is untouched", hasKey(`${UNINST}\\hproxy-checker`) && existsSync(join(LOCAL, "hproxy-checker", "hproxy-checker.exe")));
}
console.log(failed ? `${failed} check(s) failed` : "every check passed");
process.exitCode = failed ? 1 : 0;
