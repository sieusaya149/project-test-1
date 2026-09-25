import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

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

test("GET /profile.html serves the profile page with a profile container and edit form", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/profile.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const body = await res.text();
    assert.ok(body.includes(">Profile</h1>"), "page should have a Profile heading");
    assert.ok(body.includes('id="profile"'), "page should include a profile container");
    assert.ok(body.includes('id="edit-profile"'), "page should include an edit section");
    assert.ok(body.includes('name="avatarUrl"'), "edit form should have an avatar URL input");
    assert.ok(body.includes('name="bio"'), "edit form should have a bio input");
    assert.ok(body.includes("/profile.js"), "page should load the profile script");
  } finally {
    await close();
  }
});

test("GET /profile.js is wired to GET /users/:username and PATCH /users/me", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/profile.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("/users"), "profile script should fetch from /users/:username");
    assert.ok(body.includes("/users/me"), "profile script should call PATCH /users/me");
    assert.ok(body.includes("PATCH"), "profile script should send a PATCH for edits");
    assert.ok(body.includes("Bearer"), "profile script should send the auth token");
    assert.ok(body.includes("/login.html"), "profile script should send logged-out users to log in");
  } finally {
    await close();
  }
});

// Behaviour-level coverage for the profile script's username resolution. The
// script is a plain browser script (no imports/exports), so we evaluate it in a
// VM and drive its internal helpers directly.
const PROFILE_JS = readFileSync(
  fileURLToPath(new URL("../public/profile.js", import.meta.url)),
  "utf8",
);

function makeToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ sub: `${username}@example.com`, username }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

async function setupProfile({ token = null, search = "" } = {}) {
  const context = {
    console,
    atob: (str) => atob(str),
    URLSearchParams,
    localStorage: {
      getItem: (key) => (key === "instaclone.token" ? token : null),
    },
    window: { location: { search, assign() {} } },
    document: { addEventListener() {} },
    fetch: async () => {
      throw new Error("fetch not stubbed");
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `${PROFILE_JS}\n;globalThis.__profile = { currentUsername, targetUsername, base64UrlDecode };`,
    context,
  );

  return context.__profile;
}

test("targetUsername prefers the ?username= query param over the JWT", async () => {
  const profile = await setupProfile({ token: makeToken("alice"), search: "?username=bob" });
  assert.equal(profile.targetUsername(), "bob");
});

test("targetUsername falls back to the logged-in user's JWT username", async () => {
  const profile = await setupProfile({ token: makeToken("alice"), search: "" });
  assert.equal(profile.targetUsername(), "alice");
});

test("targetUsername is null when logged out and no username is given", async () => {
  const profile = await setupProfile({ token: null, search: "" });
  assert.equal(profile.targetUsername(), null);
});
