/* The look, before anything paints: the markup says dark, as the computer app
   does by default, and this turns it white for whoever chose that (popup.js,
   the Settings page). A file of its own because a popup may not run inline
   code, and localStorage because chrome.storage answers too late: the popup
   would open dark and turn white in front of you. */
if (localStorage.getItem("hproxy_look") === "white") document.documentElement.removeAttribute("data-theme");
