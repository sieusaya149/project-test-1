import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

// IN-23: comments under a post in the feed. feed.js is a plain browser script
// (no imports/exports), so we evaluate it in a VM with the few browser globals
// it touches and drive its internal helpers directly — the same way
// feed-like.test.js drives the like button.

process.env.JWT_SECRET = "feed-comments-test-secret";

const FEED_JS = readFileSync(
  fileURLToPath(new URL("../public/feed.js", import.meta.url)),
  "utf8",
);

// feed.js's submitComment calls handleUnauthorized() on a 401, so auth.js is
// evaluated in the same context to exercise the real integration path.
const AUTH_JS = readFileSync(
  fileURLToPath(new URL("../public/auth.js", import.meta.url)),
  "utf8",
);

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
    `${AUTH_JS}\n${FEED_JS}\n;globalThis.__feed = { submitComment };`,
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

test("GET /feed.js is served and wired to the comments API", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/feed.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("/comments"), "feed script should POST to the comments endpoint");
    assert.ok(body.includes("comment-form"), "feed script should build a comment form");
    assert.ok(body.includes("comment-list"), "feed script should build a comment list");
    assert.ok(body.includes("Bearer"), "feed script should send the auth token with comments");
    assert.ok(body.includes("/login"), "feed script should send logged-out users to log in");
  } finally {
    server.close();
  }
});

test("an empty comment is refused with a clear message and no request", async () => {
  const errors = [];
  const { feed, fetchCalls } = await setup({ token: "jwt-token" });
  const post = { id: "1" };

  const result = await feed.submitComment({
    post,
    text: "   ",
    token: "jwt-token",
    setError: (message) => errors.push(message),
  });

  assert.equal(result, null);
  assert.deepEqual(errors, ["Enter a comment before posting."]);
  assert.equal(fetchCalls.length, 0, "no request should be sent for an empty comment");
});

test("a comment is POSTed to the comments API with the token and trimmed text", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 201,
    json: async () => ({ id: "c1", author: "alice", text: "nice" }),
  });
  const { feed, fetchCalls } = await setup({ token: "jwt-token", fetchImpl });
  const post = { id: "1" };

  const comment = await feed.submitComment({
    post,
    text: "  nice  ",
    token: "jwt-token",
    setError: () => {},
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/posts/1/comments");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers["content-type"], "application/json");
  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer jwt-token");
  assert.equal(fetchCalls[0].options.body, JSON.stringify({ text: "nice" }));

  assert.equal(comment.author, "alice");
  assert.equal(comment.text, "nice");
});

test("a logged-out user is sent to log in without a request", async () => {
  const { feed, assignCalls, fetchCalls } = await setup({ token: null });
  const post = { id: "1" };

  const result = await feed.submitComment({
    post,
    text: "hi",
    token: null,
    setError: () => {},
  });

  assert.equal(result, null);
  assert.deepEqual(assignCalls, ["/login.html"]);
  assert.equal(fetchCalls.length, 0, "no request should be sent when logged out");
});

test("a 401 clears the token, flags session-ended and sends the user to log in", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const { feed, assignCalls, removedTokenKeys, sessionFlags } = await setup({
    token: "stale-token",
    fetchImpl,
  });
  const post = { id: "1" };

  const result = await feed.submitComment({
    post,
    text: "hi",
    token: "stale-token",
    setError: () => {},
  });

  assert.equal(result, null);
  assert.deepEqual(assignCalls, ["/login.html"]);
  assert.deepEqual(removedTokenKeys, ["instaclone.token"], "the token must be cleared");
  assert.equal(
    sessionFlags["instaclone.session-ended"],
    "1",
    "the session-ended notice must be flagged",
  );
});

test("the API error message is surfaced when commenting fails", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "comment must be 1-500 characters" }),
  });
  const errors = [];
  const { feed } = await setup({ token: "jwt-token", fetchImpl });
  const post = { id: "1" };

  const result = await feed.submitComment({
    post,
    text: "a".repeat(501),
    token: "jwt-token",
    setError: (message) => errors.push(message),
  });

  assert.equal(result, null);
  assert.deepEqual(errors, ["comment must be 1-500 characters"]);
});

test("a generic message is shown when the request throws", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const errors = [];
  const { feed } = await setup({ token: "jwt-token", fetchImpl });
  const post = { id: "1" };

  const result = await feed.submitComment({
    post,
    text: "hi",
    token: "jwt-token",
    setError: (message) => errors.push(message),
  });

  assert.equal(result, null);
  assert.deepEqual(errors, ["Couldn't post your comment."]);
});

// ---- API integration: GET /posts exposes each post's comments ----

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

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function signup(base, email, username) {
  const res = await postJson(base, "/auth/signup", { email, username, password: "password123" });
  assert.equal(res.status, 201);
}

async function login(base, email) {
  const res = await postJson(base, "/auth/login", { email, password: "password123" });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

async function postImage(base, token) {
  const res = await fetch(`${base}/posts`, {
    method: "POST",
    headers: { "content-type": "image/png", authorization: `Bearer ${token}` },
    body: Buffer.from("fake-png-bytes"),
  });
  assert.equal(res.status, 201);
  return res.json();
}

test("GET /posts returns each post's comments (author + text, oldest first)", async () => {
  const { base, close } = await startApp();
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    const post = await postImage(base, alice);

    const first = await fetch(`${base}/posts/${post.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bob}` },
      body: JSON.stringify({ text: "first!" }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${base}/posts/${post.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${alice}` },
      body: JSON.stringify({ text: "thanks" }),
    });
    assert.equal(second.status, 201);

    const feedRes = await fetch(`${base}/posts`);
    assert.equal(feedRes.status, 200);
    const feed = await feedRes.json();
    assert.equal(feed.length, 1);

    const inFeed = feed.find((p) => p.id === post.id);
    assert.ok(inFeed, "the post should appear in GET /posts");
    assert.equal(inFeed.commentCount, 2);
    // Comments stay in insertion order (oldest first) so the feed renders them
    // newest-last.
    assert.deepEqual(
      inFeed.comments.map((c) => ({ author: c.author, text: c.text })),
      [
        { author: "bob", text: "first!" },
        { author: "alice", text: "thanks" },
      ],
    );
  } finally {
    await close();
  }
});
