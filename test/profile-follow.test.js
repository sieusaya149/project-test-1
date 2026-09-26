import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

// IN-24: follow and unfollow from the profile page. The profile script is a
// plain browser script (no imports/exports), so we evaluate it in a VM with the
// browser globals it touches and drive its helpers directly, mirroring the feed
// like-button tests.

const PROFILE_JS = readFileSync(
  fileURLToPath(new URL("../public/profile.js", import.meta.url)),
  "utf8",
);

// auth.js holds the shared 401/session-ended handling profile.js calls into, so
// we evaluate it in the same context to exercise the real integration path.
const AUTH_JS = readFileSync(
  fileURLToPath(new URL("../public/auth.js", import.meta.url)),
  "utf8",
);

function makeToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ sub: `${username}@example.com`, username }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

/** A minimal DOM element that records the fields the profile script touches. */
function makeElement(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: "",
    textContent: "",
    type: "",
    disabled: false,
    src: "",
    alt: "",
    hidden: false,
    attributes: {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    addEventListener() {},
    replaceChildren(...nodes) {
      el.children = [...nodes];
    },
    classList: { toggle() {} },
  };
  return el;
}

/** Collects every descendant of `root` matching `predicate`. */
function collect(root, predicate, out = []) {
  for (const child of root.children || []) {
    if (predicate(child)) out.push(child);
    collect(child, predicate, out);
  }
  return out;
}

async function setup({ token = null, fetchImpl } = {}) {
  const assignCalls = [];
  const fetchCalls = [];
  const removedTokenKeys = [];
  const sessionFlags = {};

  const context = {
    console,
    atob: (str) => atob(str),
    URLSearchParams,
    localStorage: {
      getItem: (key) => (key === "instaclone.token" ? token : null),
      removeItem: (key) => removedTokenKeys.push(key),
    },
    sessionStorage: {
      setItem: (key, value) => {
        sessionFlags[key] = value;
      },
    },
    window: { location: { assign: (url) => assignCalls.push(url) } },
    document: {
      createElement: (tag) => makeElement(tag),
      addEventListener() {},
    },
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      if (!fetchImpl) throw new Error("fetch not stubbed");
      return fetchImpl(url, options);
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `${AUTH_JS}\n${PROFILE_JS}\n;globalThis.__profile = { toggleFollow, renderFollowButton, followButton, statsText, renderProfile };`,
    context,
  );

  return {
    profile: context.__profile,
    assignCalls,
    fetchCalls,
    removedTokenKeys,
    sessionFlags,
  };
}

test("GET /profile.js is wired to the follow API", async () => {
  const server = createApp().listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/profile.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("/follow"), "profile script should hit the follow endpoint");
    assert.ok(body.includes("follow-button"), "profile script should build a follow button");
    assert.ok(body.includes("POST"), "profile script should follow via POST");
    assert.ok(body.includes("DELETE"), "profile script should unfollow via DELETE");
    assert.ok(body.includes("Bearer"), "profile script should send the auth token");
    assert.ok(
      body.includes("/login.html"),
      "profile script should send logged-out users to log in",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("renderProfile shows the follow button on another user's profile", () => {
  const { profile } = setupWithoutAwait({ token: makeToken("alice") });
  const container = makeElement("div");
  profile.renderProfile(container, {
    username: "bob",
    avatarUrl: "",
    bio: "",
    posts: 0,
    followers: 2,
    following: 0,
  });

  const buttons = collect(container, (el) => el.className === "follow-button");
  assert.equal(buttons.length, 1, "another user's profile should get a follow button");
  assert.equal(buttons[0].textContent, "Follow");
});

test("renderProfile hides the follow button on the logged-in user's own profile", () => {
  const { profile } = setupWithoutAwait({ token: makeToken("alice") });
  const container = makeElement("div");
  profile.renderProfile(container, {
    username: "alice",
    avatarUrl: "",
    bio: "",
    posts: 0,
    followers: 2,
    following: 0,
  });

  const buttons = collect(container, (el) => el.className === "follow-button");
  assert.equal(buttons.length, 0, "your own profile should not get a follow button");
});

test("renderProfile shows the follow button when logged out and viewing someone", () => {
  const { profile } = setupWithoutAwait({ token: null });
  const container = makeElement("div");
  profile.renderProfile(container, {
    username: "bob",
    avatarUrl: "",
    bio: "",
    posts: 0,
    followers: 2,
    following: 0,
  });

  const buttons = collect(container, (el) => el.className === "follow-button");
  assert.equal(buttons.length, 1, "a logged-out viewer still sees the follow button");
});

test("follow button sends a logged-out user to log in without calling the API", async () => {
  const { profile, assignCalls, fetchCalls } = await setup({ token: null });
  const user = { username: "bob", followers: 3 };
  const button = makeElement("button");
  const stats = { textContent: "" };

  await profile.toggleFollow(user, button, stats);

  assert.deepEqual(assignCalls, ["/login.html"]);
  assert.equal(fetchCalls.length, 0);
});

test("follow button follows via POST and updates the followers count before the response lands", async () => {
  let followersAtFetch = null;
  const fetchImpl = async () => {
    followersAtFetch = user.followers;
    return { ok: true, status: 200, json: async () => ({ following: true }) };
  };
  const { profile, fetchCalls } = await setup({ token: "jwt-token", fetchImpl });
  const user = { username: "bob", followers: 3 };
  const button = makeElement("button");
  const stats = { textContent: "" };

  await profile.toggleFollow(user, button, stats);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/users/bob/follow");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer jwt-token");

  assert.equal(followersAtFetch, 4, "count should be bumped before the request resolves");
  assert.equal(user.followers, 4);
  assert.match(stats.textContent, /4 followers/);
  assert.equal(button.textContent, "Unfollow");
  assert.equal(button.disabled, false);
});

test("following again unfollows via DELETE and puts the count back", async () => {
  let following = false;
  const fetchImpl = async () => {
    following = !following;
    return { ok: true, status: 200, json: async () => ({ following }) };
  };
  const { profile, fetchCalls } = await setup({ token: "jwt-token", fetchImpl });
  const user = { username: "bob", followers: 3 };
  const button = makeElement("button");
  const stats = { textContent: "" };

  await profile.toggleFollow(user, button, stats); // follow
  await profile.toggleFollow(user, button, stats); // unfollow

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[1].options.method, "DELETE");
  assert.equal(user.followers, 3);
  assert.match(stats.textContent, /3 followers/);
  assert.equal(button.textContent, "Follow");
});

test("follow button reverts the count when the request fails", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const { profile } = await setup({ token: "jwt-token", fetchImpl });
  const user = { username: "bob", followers: 3 };
  const button = makeElement("button");
  const stats = { textContent: "" };

  await profile.toggleFollow(user, button, stats);

  assert.equal(user.followers, 3, "optimistic +1 must be reverted");
  assert.match(stats.textContent, /3 followers/);
  assert.equal(button.textContent, "Follow");
  assert.equal(button.disabled, false);
});

test("follow button clears the token and sends the user to log in when the API returns 401", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const { profile, assignCalls, removedTokenKeys, sessionFlags } = await setup({
    token: "stale-token",
    fetchImpl,
  });
  const user = { username: "bob", followers: 3 };
  const button = makeElement("button");
  const stats = { textContent: "" };

  await profile.toggleFollow(user, button, stats);

  assert.deepEqual(assignCalls, ["/login.html"]);
  assert.deepEqual(removedTokenKeys, ["instaclone.token"], "the token must be cleared");
  assert.equal(
    sessionFlags["instaclone.session-ended"],
    "1",
    "the session-ended notice must be flagged",
  );
});

// renderProfile is synchronous and only needs the prepared VM context, so we
// expose a non-async helper that shares the same context-building logic.
function setupWithoutAwait({ token = null } = {}) {
  const context = {
    console,
    atob: (str) => atob(str),
    URLSearchParams,
    localStorage: {
      getItem: (key) => (key === "instaclone.token" ? token : null),
      removeItem() {},
    },
    sessionStorage: { setItem() {} },
    window: { location: { assign() {} } },
    document: {
      createElement: (tag) => makeElement(tag),
      addEventListener() {},
    },
    fetch: async () => {
      throw new Error("fetch not stubbed");
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `${AUTH_JS}\n${PROFILE_JS}\n;globalThis.__profile = { toggleFollow, renderFollowButton, followButton, statsText, renderProfile };`,
    context,
  );

  return { profile: context.__profile };
}
