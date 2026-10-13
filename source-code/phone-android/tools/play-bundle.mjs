// The Google Play bundle of the native Android app, for the release tool's google-play channel
// (the release tool runs it from desktop-app/):
//
//   node phone-android/tools/play-bundle.mjs
//
// Builds `:app:bundleRelease` for all four chip types, proves it before anything is kept, and
// puts it where the release tool keeps it:
//   finished-installers/android-<version>-google-play/HProxy_<version>_google-play.aab
// with SHA256SUMS and COMMIT beside it. The version is the product's
// (desktop-app/src-tauri/tauri.conf.json), which app/build.gradle.kts reads too.
//
// The proofs: signed with the upload key the Play app was created with (Play refuses any other),
// and every engine library laid out for 16 KB memory pages (Play refuses the rest: "Your app does
// not support 16 KB memory page sizes").

import { spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const phone = join(here, "..");
const repo = join(phone, "..");
const windows = process.platform === "win32";

/** The upload certificate's SHA-256 (public: Play shows it in App integrity). */
const UPLOAD_CERT = "3A:4D:1D:E3:DC:97:11:33:34:1F:D3:72:96:F7:5A:91:3C:69:E2:49:C2:DA:1D:B6:34:71:DA:4D:C1:EC:63:19";
const ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];

const fail = (why) => {
  console.error(`play-bundle: ${why}`);
  process.exit(1);
};
const run = (cmd, args, options) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} stopped (${r.status ?? r.error?.code})`);
};

const conf = readFileSync(join(repo, "desktop-app", "src-tauri", "tauri.conf.json"), "utf8");
const version = conf.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/)?.[1] ?? fail("no version in tauri.conf.json");
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

// Gradle by its full path: a .bat file only starts through cmd.exe, and cmd.exe skips the
// current folder when NoDefaultCurrentDirectoryInExePath is set (some shells set it).
// A Gradle daemon left from an earlier build holds classes.dex on Windows: R8 then fails to write it.
const gradlew = windows ? `"${join(phone, "gradlew.bat")}"` : join(phone, "gradlew");
spawnSync(gradlew, ["--stop"], { cwd: phone, stdio: "ignore", shell: windows });
run(gradlew, [":app:bundleRelease", "-Pabis=all", "-q"], { cwd: phone, shell: windows });

const aab = join(phone, "app", "build", "outputs", "bundle", "release", "app-release.aab");
if (!existsSync(aab)) fail(`no bundle at ${aab}`);

// Signed with the upload key. keytool and jar are programs of the JDK, started without a shell.
const cert = spawnSync("keytool", ["-printcert", "-jarfile", aab], { encoding: "utf8" });
const sha = (cert.stdout || "").match(/SHA256:\s*([0-9A-F:]+)/)?.[1];
if (sha !== UPLOAD_CERT) fail(`signed with ${sha ?? "no key"}, not the Play upload key: is keystore.properties there?`);

// 16 KB pages, every chip type.
const sdk = readFileSync(join(phone, "local.properties"), "utf8").match(/sdk\.dir=(.+)/)?.[1]?.trim().replace(/\\:/g, ":").replace(/\\\\/g, "/");
const ndkVersion = readFileSync(join(phone, "app", "build.gradle.kts"), "utf8").match(/ndkVersion = "([^"]+)"/)?.[1];
if (!sdk || !ndkVersion) fail("no sdk.dir in local.properties or no ndkVersion in build.gradle.kts");
const host = windows ? "windows-x86_64" : process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
const readelf = join(sdk, "ndk", ndkVersion, "toolchains", "llvm", "prebuilt", host, "bin", windows ? "llvm-readelf.exe" : "llvm-readelf");
const tmp = mkdtempSync(join(tmpdir(), "play-bundle-"));
try {
  // The bundle is a zip: jar reads it everywhere (the first "tar" on the PATH can be Git's, which reads no zip).
  run("jar", ["xf", aab, "base/lib"], { cwd: tmp });
  for (const abi of ABIS) {
    const so = join(tmp, "base", "lib", abi, "libhproxy_mobile.so");
    if (!existsSync(so)) fail(`no engine for ${abi} in the bundle`);
    const out = spawnSync(readelf, ["-lW", so], { encoding: "utf8" }).stdout || "";
    const aligns = [...out.matchAll(/^\s*LOAD\s.*\s(0x[0-9a-f]+)\s*$/gm)].map((m) => m[1]);
    if (!aligns.length || aligns.some((a) => a !== "0x4000")) fail(`${abi}: LOAD alignment ${aligns.join(",") || "unknown"}, not 0x4000 (16 KB)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const folder = join(repo, "finished-installers", `android-${version}-google-play`);
mkdirSync(folder, { recursive: true });
const name = `HProxy_${version}_google-play.aab`;
copyFileSync(aab, join(folder, name));
const digest = await new Promise((resolve, reject) => {
  const h = createHash("sha256");
  createReadStream(join(folder, name)).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});
writeFileSync(join(folder, "SHA256SUMS"), `${digest} *${name}\n`);
writeFileSync(join(folder, "COMMIT"), `${commit}\n`);
console.log(`play-bundle: ${name} (${version}, ${ABIS.length} chip types, 16 KB pages, upload key), sha256 ${digest.slice(0, 16)}…, in ${folder}`);
