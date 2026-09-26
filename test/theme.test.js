import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

// IN-27: every served page carries a header theme switch plus a small theme
// script in <head> that applies the saved theme before first paint (no flash of
// the light theme). The switch and script are enumerated straight from public/
// so a page added later is covered automatically.

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const HTML_PAGES = readdirSync(PUBLIC_DIR)
  .filter((file) => file.endsWith(".html"))
  .sort();

async function startApp() {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

test("every served page includes the theme switch and the theme script in <head>", async () => {
  const { base, close } = await startApp();
  try {
    for (const page of HTML_PAGES) {
      const path = page === "index.html" ? "/" : `/${page}`;
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${page} should be served`);
      const html = await res.text();

      assert.ok(
        html.includes('id="theme-toggle"'),
        `${page}: should include the theme switch`,
      );
      assert.ok(
        html.includes('class="theme-toggle"'),
        `${page}: the theme switch should carry its class`,
      );
      assert.ok(
        html.includes('src="/theme.js"'),
        `${page}: should include the theme script`,
      );

      // The script must run before the body paints to avoid a light-theme
      // flash, so it belongs in <head> (before the first <body ...> tag).
      const scriptAt = html.indexOf('src="/theme.js"');
      const bodyAt = html.indexOf("<body");
      assert.ok(scriptAt !== -1 && bodyAt !== -1, `${page}: expected head + body`);
      assert.ok(
        scriptAt < bodyAt,
        `${page}: the theme script must load in <head>, before <body>`,
      );
    }
  } finally {
    await close();
  }
});

test("GET /theme.js is served with the right content type and wired to the theme", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/theme.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("instaclone.theme"), "theme script should use its storage key");
    assert.ok(body.includes("data-theme"), "theme script should set the data-theme attribute");
    assert.ok(body.includes("theme-toggle"), "theme script should wire the header switch");
  } finally {
    await close();
  }
});

// Behaviour-level coverage for theme.js. It is a plain browser script (no
// imports/exports) that runs synchronously, so we evaluate it in a VM with a
// minimal DOM and localStorage and drive the bootstrap + toggle directly.

const THEME_JS = readFileSync(
  fileURLToPath(new URL("../public/theme.js", import.meta.url)),
  "utf8",
);

/** Builds a minimal document + localStorage for theme.js to run against. */
function makeDom(saved) {
  const attributes = {};
  const documentElement = {
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name]
        : null;
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
  };

  const buttonAttrs = {};
  const buttonListeners = {};
  const button = {
    textContent: "",
    setAttribute(name, value) {
      buttonAttrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(buttonAttrs, name)
        ? buttonAttrs[name]
        : null;
    },
    addEventListener(type, fn) {
      buttonListeners[type] = fn;
    },
  };

  const listeners = {};
  const document = {
    documentElement,
    getElementById(id) {
      return id === "theme-toggle" ? button : null;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };

  const data = new Map();
  if (saved !== undefined) {
    data.set("instaclone.theme", String(saved));
  }
  const localStorage = {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };

  return { attributes, button, buttonListeners, document, listeners, localStorage };
}

/** Runs theme.js in a fresh VM context wired to the given fake DOM. */
function loadTheme(dom) {
  const context = vm.createContext({
    document: dom.document,
    localStorage: dom.localStorage,
  });
  vm.runInContext(THEME_JS, context);
}

test("theme bootstrap defaults to light and applies a saved dark theme before paint", () => {
  const light = makeDom();
  loadTheme(light);
  assert.equal(light.attributes["data-theme"], "light", "default theme is light");

  const dark = makeDom("dark");
  loadTheme(dark);
  assert.equal(
    dark.attributes["data-theme"],
    "dark",
    "a saved dark theme is applied during bootstrap",
  );
});

test("the header switch toggles the theme and persists the choice", () => {
  const dom = makeDom("light");
  loadTheme(dom);

  // DOM-ready wiring: the button reflects the current (light) theme.
  dom.listeners.DOMContentLoaded();
  assert.equal(dom.button.textContent, "Dark", "light theme offers the dark switch");
  assert.equal(dom.button.getAttribute("aria-pressed"), "false");

  // Clicking switches to dark and persists it.
  dom.buttonListeners.click();
  assert.equal(dom.attributes["data-theme"], "dark");
  assert.equal(dom.localStorage.getItem("instaclone.theme"), "dark");
  assert.equal(dom.button.textContent, "Light", "dark theme offers the light switch");
  assert.equal(dom.button.getAttribute("aria-pressed"), "true");

  // Clicking again switches back to light.
  dom.buttonListeners.click();
  assert.equal(dom.attributes["data-theme"], "light");
  assert.equal(dom.localStorage.getItem("instaclone.theme"), "light");
  assert.equal(dom.button.getAttribute("aria-pressed"), "false");
});
