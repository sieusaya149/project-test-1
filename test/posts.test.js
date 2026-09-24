import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createPostStore } from "../src/store.js";

process.env.JWT_SECRET = "test-secret";

const MAX_POST_BYTES = 10 * 1024 * 1024;

async function startApp(app) {
  const server = app.listen(0);
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

async function signup(base, email, username, password = "password123") {
  const res = await postJson(base, "/auth/signup", { email, username, password });
  assert.equal(res.status, 201);
}

async function login(base, email, password = "password123") {
  const res = await postJson(base, "/auth/login", { email, password });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.token;
}

async function postImage(base, token, { contentType = "image/png", body, caption } = {}) {
  const query = caption === undefined ? "" : `?caption=${encodeURIComponent(caption)}`;
  return fetch(`${base}/posts${query}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      authorization: `Bearer ${token}`,
    },
    body,
  });
}

test("POST /posts stores the image URL, caption and author, and bumps the author's posts count", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    const token = await login(base, "alice@example.com");

    const res = await postImage(base, token, {
      contentType: "image/png",
      body: Buffer.from("fake-png-bytes"),
      caption: "sunset over the bay",
    });
    assert.equal(res.status, 201);
    const post = await res.json();
    assert.equal(post.id, "1");
    assert.equal(post.imageUrl, "/posts/1/image");
    assert.equal(post.caption, "sunset over the bay");
    assert.equal(post.author, "alice");

    const profileRes = await fetch(`${base}/users/alice`);
    assert.equal(profileRes.status, 200);
    const profile = await profileRes.json();
    assert.equal(profile.posts, 1);
  } finally {
    await close();
  }
});

test("POST /posts accepts JPEG as well as PNG", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "bob@example.com", "bob");
    const token = await login(base, "bob@example.com");

    const res = await postImage(base, token, {
      contentType: "image/jpeg",
      body: Buffer.from("fake-jpeg-bytes"),
    });
    assert.equal(res.status, 201);
    const post = await res.json();
    assert.equal(post.id, "1");
    assert.equal(post.author, "bob");
    assert.equal(post.caption, "");
  } finally {
    await close();
  }
});

test("POST /posts rejects non-image content types with 415", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "carol@example.com", "carol");
    const token = await login(base, "carol@example.com");

    const res = await postImage(base, token, {
      contentType: "text/plain",
      body: Buffer.from("not an image"),
    });
    assert.equal(res.status, 415);
  } finally {
    await close();
  }
});

test("POST /posts rejects bodies over 10 MB with 413", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "dave@example.com", "dave");
    const token = await login(base, "dave@example.com");

    const res = await postImage(base, token, {
      contentType: "image/png",
      body: Buffer.alloc(MAX_POST_BYTES + 1),
    });
    assert.equal(res.status, 413);

    // The oversized upload must not create a post or bump the posts count.
    const profileRes = await fetch(`${base}/users/dave`);
    const profile = await profileRes.json();
    assert.equal(profile.posts, 0);
  } finally {
    await close();
  }
});

test("POST /posts returns 401 without a valid token", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const res = await fetch(`${base}/posts`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.from("fake-png-bytes"),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("createPostStore exposes add, list and findById", () => {
  const posts = createPostStore();
  const first = posts.add({ author: "alice", caption: "hello" });
  const second = posts.add({ author: "bob" });

  assert.equal(first.id, "1");
  assert.equal(first.imageUrl, "/posts/1/image");
  assert.equal(first.author, "alice");
  assert.equal(first.caption, "hello");

  assert.equal(second.id, "2");
  assert.equal(second.caption, "");

  assert.deepEqual(posts.list(), [first, second]);
  assert.equal(posts.findById("1"), first);
  assert.equal(posts.findById("999"), undefined);
});
