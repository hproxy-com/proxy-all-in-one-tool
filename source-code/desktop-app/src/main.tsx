import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/dm-sans";
import "flag-icons/css/flag-icons.min.css";
import "./styles/globals.css";
import App from "./App";
import { applyLook, loadPicture } from "./lib/look";
import { startPress } from "./lib/press";
import { loadSettings } from "./lib/settings";

// Every control presses and springs back (styles/globals.css, "Pressing").
startPress();

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
