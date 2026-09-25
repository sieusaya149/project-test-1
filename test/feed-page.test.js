import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

test("GET / serves the feed page with a feed container and loading state", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const body = await res.text();
    assert.ok(body.includes('id="feed"'), "page should include the feed container");
    assert.ok(body.includes("Loading"), "page should include a loading state");
    assert.ok(body.includes("/feed.js"), "page should load the feed script");
  } finally {
    server.close();
  }
});

test("GET /feed.js is served and wired to the /posts endpoint", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/feed.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("/posts"), "feed script should fetch from /posts");
  } finally {
    server.close();
  }
});
