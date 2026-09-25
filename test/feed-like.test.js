import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Behaviour-level coverage for the feed like button. feed.js is a plain browser
// script (no imports/exports), so we evaluate it in a VM with the few browser
// globals it touches and drive its internal helpers directly.

const FEED_JS = readFileSync(
  fileURLToPath(new URL("../public/feed.js", import.meta.url)),
  "utf8",
);

// auth.js holds the shared 401/session-ended handling feed.js calls into, so we
// evaluate it in the same context to exercise the real integration path.
const AUTH_JS = readFileSync(
  fileURLToPath(new URL("../public/auth.js", import.meta.url)),
  "utf8",
);

/** A minimal fake <button> that records the fields renderLikeButton touches. */
function makeButton() {
  return {
    textContent: "",
    disabled: false,
    classList: { toggle() {} },
    setAttribute() {},
  };
}

async function setup({ token = null, fetchImpl } = {}) {
  const assignCalls = [];
  const fetchCalls = [];
  const removedTokenKeys = [];
  const sessionFlags = {};

  const context = {
    console,
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
    document: { addEventListener() {} },
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      if (!fetchImpl) throw new Error("fetch not stubbed");
      return fetchImpl(url, options);
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `${AUTH_JS}\n${FEED_JS}\n;globalThis.__feed = { toggleLike, likeButton, renderLikeButton };`,
    context,
  );

  return {
    feed: context.__feed,
    assignCalls,
    fetchCalls,
    removedTokenKeys,
    sessionFlags,
  };
}

test("like button sends a logged-out user to log in without calling the API", async () => {
  const { feed, assignCalls, fetchCalls } = await setup({ token: null });
  const post = { id: "1", likeCount: 0, author: "alice" };
  const button = makeButton();

  await feed.toggleLike(post, button);

  assert.deepEqual(assignCalls, ["/login.html"]);
  assert.equal(fetchCalls.length, 0);
});

test("like button likes via POST and updates the count before the response lands", async () => {
  let countAtFetch = null;
  const fetchImpl = async () => {
    countAtFetch = post.likeCount;
    return { ok: true, status: 200, json: async () => ({ liked: true, likeCount: 1 }) };
  };
  const { feed, fetchCalls } = await setup({ token: "jwt-token", fetchImpl });
  const post = { id: "1", likeCount: 0, author: "alice" };
  const button = makeButton();

  await feed.toggleLike(post, button);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/posts/1/like");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer jwt-token");

  assert.equal(countAtFetch, 1, "count should be bumped before the request resolves");
  assert.equal(post.likeCount, 1);
  assert.match(button.textContent, /♥ 1/);
  assert.equal(button.disabled, false);
});

test("liking again unlikes via DELETE and puts the count back", async () => {
  let liked = false;
  const fetchImpl = async () => {
    liked = !liked;
    return {
      ok: true,
      status: 200,
      json: async () => ({ liked, likeCount: liked ? 1 : 0 }),
    };
  };
  const { feed, fetchCalls } = await setup({ token: "jwt-token", fetchImpl });
  const post = { id: "1", likeCount: 0, author: "alice" };
  const button = makeButton();

  await feed.toggleLike(post, button); // like
  await feed.toggleLike(post, button); // unlike

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[1].options.method, "DELETE");
  assert.equal(post.likeCount, 0);
  assert.match(button.textContent, /♡ 0/);
});

test("like button reverts the count when the request fails", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const { feed } = await setup({ token: "jwt-token", fetchImpl });
  const post = { id: "1", likeCount: 0, author: "alice" };
  const button = makeButton();

  await feed.toggleLike(post, button);

  assert.equal(post.likeCount, 0, "optimistic +1 must be reverted");
  assert.match(button.textContent, /♡ 0/);
  assert.equal(button.disabled, false);
});

test("like button clears the stored token and sends the user to log in when the API returns 401", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const { feed, assignCalls, removedTokenKeys, sessionFlags } = await setup({
    token: "stale-token",
    fetchImpl,
  });
  const post = { id: "1", likeCount: 0, author: "alice" };
  const button = makeButton();

  await feed.toggleLike(post, button);

  assert.deepEqual(assignCalls, ["/login.html"]);
  assert.deepEqual(removedTokenKeys, ["instaclone.token"], "the token must be cleared");
  assert.equal(
    sessionFlags["instaclone.session-ended"],
    "1",
    "the session-ended notice must be flagged",
  );
});
