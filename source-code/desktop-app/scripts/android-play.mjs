// android-play.mjs: the Android App Bundle (.aab) for Google Play, signed with the upload key.
// Run from desktop-app/:
//
//   node scripts/android-play.mjs         ../builds/android-<version>-google-play/HProxy_<version>_google-play.aab
//   node scripts/android-play.mjs --apk   also a universal APK of the same build, to try it on a
//                                         phone first (it names Google Play in Settings, so it is
//                                         not the APK for the releases page)
//
// This build tells the app it came from Google Play (VITE_APP_STORE=google-play): Play updates
// that copy, so Settings offers the Play page instead of the releases page. The upload key is
// named in src-tauri/gen/android/keystore.properties, which is not in the repository; Play checks
// that key on every upload and signs what it publishes with its own. Java, the Android SDK and the
// NDK come from JAVA_HOME, ANDROID_HOME and NDK_HOME, or from Android Studio's usual places.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(APP, "..");
const ANDROID = join(APP, "src-tauri", "gen", "android");
const KEYSTORE_PROPERTIES = join(ANDROID, "keystore.properties");
const OUTPUTS = join(ANDROID, "app", "build", "outputs");
const BUNDLE = join(OUTPUTS, "bundle", "universalRelease", "app-universal-release.aab");
const APK = join(OUTPUTS, "apk", "universal", "release", "app-universal-release.apk");

const withApk = process.argv.slice(2).includes("--apk");

/** The first of these folders that exists. */
function firstFolder(...candidates) {
  return candidates.find((folder) => folder && existsSync(folder));
}

/** key=value lines, as Gradle's properties files have them. */
function readProperties(file) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const javaHome = firstFolder(process.env.JAVA_HOME, "C:\\Program Files\\Android\\Android Studio\\jbr");
const androidHome = firstFolder(process.env.ANDROID_HOME, join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk"));
if (!javaHome) throw new Error("no Java: set JAVA_HOME to a JDK 17 or newer (Android Studio brings one)");
if (!androidHome) throw new Error("no Android SDK: set ANDROID_HOME (Android Studio installs it)");
const ndks = existsSync(join(androidHome, "ndk")) ? readdirSync(join(androidHome, "ndk")) : [];
ndks.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const ndkHome = firstFolder(process.env.NDK_HOME, ndks.length ? join(androidHome, "ndk", ndks.at(-1)) : undefined);
if (!ndkHome) throw new Error(`no NDK: install one in Android Studio's SDK Manager (${join(androidHome, "ndk")})`);

// An unsigned bundle is refused by Play, so a missing key stops the build before it starts.
if (!existsSync(KEYSTORE_PROPERTIES)) throw new Error(`no ${KEYSTORE_PROPERTIES}: it names the upload key`);
const key = readProperties(KEYSTORE_PROPERTIES);
if (!key.storeFile || !existsSync(key.storeFile)) throw new Error(`the upload key ${key.storeFile} is not on this PC`);

const conf = JSON.parse(readFileSync(join(APP, "src-tauri", "tauri.conf.json"), "utf8"));
const out = join(ROOT, "builds", `android-${conf.version}-google-play`);
mkdirSync(out, { recursive: true });
const log = createWriteStream(join(out, "build.log"));
const started = Date.now();

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome, NDK_HOME: ndkHome, VITE_APP_STORE: "google-play" };
const buildArgs = ["tauri", "android", "build", "--aab", ...(withApk ? ["--apk"] : [])];
console.log(`building ${conf.version} for Google Play (JAVA_HOME ${javaHome}, NDK ${ndkHome})`);
log.write(`${new Date(started).toISOString()} npx ${buildArgs.join(" ")}\n`);

const code = await new Promise((resolve) => {
  const child = spawn("npx", buildArgs, { cwd: APP, env, shell: true });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
  }
  child.on("close", resolve);
});
log.end();
if (code !== 0) throw new Error(`the Android build failed (exit ${code}); the output is in ${join(out, "build.log")}`);

// The outputs folder still holds the files of earlier builds, so each file must be from this run.
const made = [[BUNDLE, `HProxy_${conf.version}_google-play.aab`]];
if (withApk) made.push([APK, `HProxy_${conf.version}_google-play-universal.apk`]);
for (const [file] of made) {
  if (!existsSync(file) || statSync(file).mtimeMs < started) throw new Error(`${file} was not written by this build`);
}

const built = readProperties(join(ANDROID, "app", "tauri.properties"));
if (built["tauri.android.versionName"] !== conf.version) {
  throw new Error(`the build says version ${built["tauri.android.versionName"]}, tauri.conf.json says ${conf.version}`);
}

// Play accepts an upload only when it is signed with the upload key it knows. Compare the
// bundle's signer with the key's own certificate before anyone tries.
const keytool = join(javaHome, "bin", "keytool.exe");
const sha256 = (text) => (/SHA256:\s*([0-9A-F:]+)/.exec(text) ?? [])[1];
const signer = sha256(execFileSync(keytool, ["-printcert", "-jarfile", BUNDLE], { encoding: "utf8" }));
const upload = sha256(
  execFileSync(keytool, ["-list", "-v", "-keystore", key.storeFile, "-alias", key.keyAlias, "-storepass:env", "HPROXY_UPLOAD_KEY_PASSWORD"], {
    encoding: "utf8",
    env: { ...process.env, HPROXY_UPLOAD_KEY_PASSWORD: key.password },
  }),
);
if (!signer || signer !== upload) throw new Error(`the bundle is signed by ${signer ?? "nobody"}, the upload key is ${upload}`);

const sums = [];
for (const [file, name] of made) {
  copyFileSync(file, join(out, name));
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  sums.push(`${hash}  ${name}`);
  console.log(`${join(out, name)} (${(statSync(file).size / 1048576).toFixed(1)} MB)`);
}
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`version ${conf.version}, version code ${built["tauri.android.versionCode"]}, signed by the upload key (SHA-256 ${signer})`);
