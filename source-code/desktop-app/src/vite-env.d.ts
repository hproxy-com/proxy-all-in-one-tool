/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "google-play" in the build uploaded to Google Play (scripts/android-play.mjs); unset otherwise. */
  readonly VITE_APP_STORE?: "google-play";
}
