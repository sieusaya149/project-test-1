import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Behaviour-level coverage for the expired/invalid-session path (IN-18). The
// frontend has no imports/exports, so we evaluate auth.js in a VM and drive its
// helpers and DOMContentLoaded handler directly.

const AUTH_JS = readFileSync(
  fileURLToPath(new URL("../public/auth.js", import.meta.url)),
  "utf8",
);

test("handleUnauthorized clears the token, flags the notice and redirects to log in", () => {
  const removed = [];
  const sessionFlags = {};
  const assignCalls = [];

  const context = {
    console,
    localStorage: {
      getItem: () => null,
      removeItem: (key) => removed.push(key),
    },
    sessionStorage: {
      setItem: (key, value) => {
        sessionFlags[key] = value;
      },
    },
    window: { location: { assign: (url) => assignCalls.push(url) } },
    document: { addEventListener() {} },
  };

  vm.createContext(context);
  vm.runInContext(
    `${AUTH_JS}\n;globalThis.__handleUnauthorized = handleUnauthorized;`,
    context,
  );

  context.__handleUnauthorized();

  assert.deepEqual(removed, ["instaclone.token"], "the stored token must be cleared");
  assert.equal(
    sessionFlags["instaclone.session-ended"],
    "1",
    "the session-ended notice must be flagged",
  );
  assert.deepEqual(assignCalls, ["/login.html"], "the user must be sent to the log-in page");
});

test("the log-in page shows the session-ended notice after a 401 redirect", () => {
  const errorBox = { textContent: "", hidden: true };
  const removedFlags = [];
  let domReady = null;

  const context = {
    console,
    localStorage: { getItem: () => null },
    sessionStorage: {
      getItem: () => "1",
      removeItem: (key) => removedFlags.push(key),
    },
    window: {},
    document: {
      addEventListener: (type, fn) => {
        if (type === "DOMContentLoaded") domReady = fn;
      },
      getElementById: (id) => {
        if (id === "login-form") return { addEventListener() {} };
        if (id === "form-error") return errorBox;
        return null;
      },
      querySelectorAll: () => [],
    },
  };

  vm.createContext(context);
  vm.runInContext(AUTH_JS, context);

  domReady();

  assert.equal(
    errorBox.textContent,
    "Your session has ended — please log in again",
    "the notice should tell the user their session ended",
  );
  assert.equal(errorBox.hidden, false, "the notice should be visible");
  assert.deepEqual(removedFlags, ["instaclone.session-ended"], "the flag should be consumed");
});
