// Theme bootstrap + header toggle for the plain-JS frontend. No framework, no
// build step. The saved theme lives in localStorage under `instaclone.theme`.
//
// The bootstrap half runs synchronously — this script is loaded in <head> — so
// the saved theme is applied before the page paints and there is no flash of the
// light theme for a user who prefers dark.
(function () {
  const THEME_KEY = "instaclone.theme";

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // localStorage can be unavailable in some privacy modes; the attribute
      // above still applies for this page.
    }
    syncToggle();
  }

  function syncToggle() {
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    const dark = currentTheme() === "dark";
    button.setAttribute("aria-pressed", String(dark));
    button.setAttribute(
      "aria-label",
      dark ? "Switch to light theme" : "Switch to dark theme",
    );
    button.textContent = dark ? "Light" : "Dark";
  }

  // 1) Apply the saved theme before first paint.
  let saved;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  document.documentElement.setAttribute(
    "data-theme",
    saved === "dark" ? "dark" : "light",
  );

  // 2) Wire the header switch once the DOM is ready.
  document.addEventListener("DOMContentLoaded", () => {
    syncToggle();
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    button.addEventListener("click", () => {
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  });
})();
