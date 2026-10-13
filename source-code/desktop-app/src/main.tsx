import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
// DM Sans stays for the wordmark only (Wordmark.tsx): the brand's letters.
import "@fontsource-variable/dm-sans";
import "flag-icons/css/flag-icons.min.css";
import "./styles/globals.css";
import "./styles/connect-designs.css";
import "./styles/connect-mix.css";
import "./styles/settings.css";
import "./styles/pages.css";
import "./styles/tips.css";
import "./styles/phone.css";
import App from "./App";
import { listenForBack } from "./lib/back";
import { applyLook, loadPicture } from "./lib/look";
import { followInsets } from "./lib/phone";
import { startPress } from "./lib/press";
import { loadSettings } from "./lib/settings";
import { isMobile } from "./lib/tauri";

// Every control presses and springs back (styles/globals.css, "Pressing").
startPress();

// A phone: its own frame (styles/phone.css reads data-phone), the room its
// bars take, and Back, which goes through the app instead of ending it.
if (isMobile()) {
  document.documentElement.dataset.phone = "";
  followInsets();
  listenForBack();
}

// The background and the theme before the first frame, so the app never
// flashes a look the person did not choose. App keeps them in step after.
{
  const s = loadSettings();
  applyLook(s.background, loadPicture());
  if (s.theme === "midnight") document.documentElement.setAttribute("data-theme", "midnight");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
