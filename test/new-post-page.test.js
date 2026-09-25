import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

const NEW_POST_JS = readFileSync(
  fileURLToPath(new URL("../public/new-post.js", import.meta.url)),
  "utf8",
);

// Behaviour-level coverage for the New post page. new-post.js is a plain browser
// script (no imports/exports), so we evaluate it in a VM and drive its internal
// helpers directly, the same way feed-like.test.js drives feed.js.
async function setup() {
  const context = {
    console,
    localStorage: { getItem: () => null },
    window: { location: { assign() {} } },
    document: { addEventListener() {} },
  };
  vm.createContext(context);
  vm.runInContext(
    `${NEW_POST_JS}\n;globalThis.__np = { fileError, submitNewPost, MAX_POST_BYTES, ACCEPTED_IMAGE_TYPES };`,
    context,
  );
  return context.__np;
}

test("GET /new-post.html serves the New post page with a file picker and caption field", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/new-post.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const body = await res.text();
    assert.ok(body.includes("<h1>New post</h1>"), "page should have a New post heading");
    assert.ok(body.includes('type="file"'), "page should have a file input");
    assert.ok(
      body.includes('accept="image/jpeg,image/png"'),
      "file picker should accept JPEG and PNG",
    );
    assert.ok(body.includes('name="caption"'), "page should have a caption field");
    assert.ok(body.includes("/new-post.js"), "page should load the new-post script");
  } finally {
    server.close();
  }
});

test("GET /new-post.js is served and wired to the /posts endpoint", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/new-post.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("/posts"), "new-post script should POST to /posts");
    assert.ok(body.includes("image/jpeg"), "new-post script should accept JPEG");
    assert.ok(body.includes("image/png"), "new-post script should accept PNG");
    assert.ok(body.includes("10 MB"), "new-post script should enforce the 10 MB limit");
    assert.ok(body.includes("Bearer"), "new-post script should send the auth token");
    assert.ok(body.includes("/login"), "new-post script should send logged-out users to log in");
  } finally {
    server.close();
  }
});

test("a non-JPEG/PNG file is refused with a clear message before any upload", async () => {
  const np = await setup();

  assert.equal(np.fileError(null), "Choose a photo to post.");
  assert.match(np.fileError({ type: "image/gif", size: 1024 }), /JPEG|PNG/);
  assert.match(np.fileError({ type: "text/plain", size: 1024 }), /JPEG|PNG/);
  assert.equal(np.fileError({ type: "image/jpeg", size: 1024 }), null);
  assert.equal(np.fileError({ type: "image/png", size: 1024 }), null);
});

test("a file over 10 MB is refused with a clear message", async () => {
  const np = await setup();

  assert.match(
    np.fileError({ type: "image/png", size: np.MAX_POST_BYTES + 1 }),
    /10 MB/,
  );
  assert.equal(np.fileError({ type: "image/png", size: np.MAX_POST_BYTES }), null);
});

test("submitNewPost sends a logged-out user to log in without uploading", async () => {
  const np = await setup();
  const goToLoginCalls = [];
  const setErrors = [];
  let fetched = false;

  const result = await np.submitNewPost({
    token: null,
    file: { type: "image/png", size: 1024 },
    caption: "",
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 201, json: async () => ({}) };
    },
    goToFeed: () => {},
    goToLogin: (url) => goToLoginCalls.push(url),
    setError: (m) => setErrors.push(m),
  });

  assert.equal(result.posted, false);
  assert.deepEqual(goToLoginCalls, ["/login.html"]);
  assert.equal(fetched, false, "no request should be sent when logged out");
  assert.deepEqual(setErrors, []);
});

test("submitNewPost uploads a valid image with the token and returns to the feed", async () => {
  const np = await setup();
  const fetchCalls = [];
  const goToFeedCalls = [];

  const file = { type: "image/jpeg", size: 2048 };
  const result = await np.submitNewPost({
    token: "jwt-token",
    file,
    caption: "hello world",
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 201, json: async () => ({ id: "1" }) };
    },
    goToFeed: (url) => goToFeedCalls.push(url),
    goToLogin: () => {},
    setError: () => {},
  });

  assert.equal(result.posted, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/posts?caption=hello%20world");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers["content-type"], "image/jpeg");
  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer jwt-token");
  assert.equal(fetchCalls[0].options.body, file);
  assert.deepEqual(goToFeedCalls, ["/"]);
});

test("submitNewPost redirects to log in when the API returns 401", async () => {
  const np = await setup();
  const goToLoginCalls = [];

  const result = await np.submitNewPost({
    token: "stale-token",
    file: { type: "image/png", size: 1024 },
    caption: "",
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    goToFeed: () => {},
    goToLogin: (url) => goToLoginCalls.push(url),
    setError: () => {},
  });

  assert.equal(result.posted, false);
  assert.deepEqual(goToLoginCalls, ["/login.html"]);
});

test("submitNewPost reports the API error message when posting fails", async () => {
  const np = await setup();
  const errors = [];

  const result = await np.submitNewPost({
    token: "jwt-token",
    file: { type: "image/png", size: 1024 },
    caption: "",
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "image exceeds 10 MB limit" }),
    }),
    goToFeed: () => {},
    goToLogin: () => {},
    setError: (m) => errors.push(m),
  });

  assert.equal(result.posted, false);
  assert.deepEqual(errors, ["image exceeds 10 MB limit"]);
});

test("submitNewPost shows a generic message when the request throws", async () => {
  const np = await setup();
  const errors = [];

  const result = await np.submitNewPost({
    token: "jwt-token",
    file: { type: "image/png", size: 1024 },
    caption: "",
    fetchImpl: async () => {
      throw new Error("network down");
    },
    goToFeed: () => {},
    goToLogin: () => {},
    setError: (m) => errors.push(m),
  });

  assert.equal(result.posted, false);
  assert.deepEqual(errors, ["Couldn't post. Please try again."]);
});
