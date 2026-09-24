import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

process.env.JWT_SECRET = "test-secret";

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

async function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function signup(base, email, username, password = "password123") {
  const res = await post(base, "/auth/signup", { email, username, password });
  assert.equal(res.status, 201);
}

async function login(base, email, password = "password123") {
  const res = await post(base, "/auth/login", { email, password });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.token;
}

test("GET /users/:username returns avatar URL, bio and the three counts", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");

    const res = await fetch(`${base}/users/alice`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      username: "alice",
      avatarUrl: "",
      bio: "",
      posts: 0,
      followers: 0,
      following: 0,
    });
  } finally {
    await close();
  }
});

test("GET /users/:username returns 404 for an unknown username", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const res = await fetch(`${base}/users/ghost`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("PATCH /users/me edits bio and avatar with a valid token", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "bob@example.com", "bob");
    const token = await login(base, "bob@example.com");

    const res = await fetch(`${base}/users/me`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        bio: "hello world",
        avatarUrl: "https://example.com/bob.png",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bio, "hello world");
    assert.equal(body.avatarUrl, "https://example.com/bob.png");

    // The change is visible on the public profile too.
    const profileRes = await fetch(`${base}/users/bob`);
    assert.equal(profileRes.status, 200);
    const profile = await profileRes.json();
    assert.equal(profile.bio, "hello world");
    assert.equal(profile.avatarUrl, "https://example.com/bob.png");
  } finally {
    await close();
  }
});

test("PATCH /users/me supports a partial update (bio only)", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "carol@example.com", "carol");
    const token = await login(base, "carol@example.com");

    const res = await fetch(`${base}/users/me`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ bio: "just the bio" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bio, "just the bio");
    assert.equal(body.avatarUrl, "");
  } finally {
    await close();
  }
});

test("PATCH /users/me returns 401 without a token", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "dave@example.com", "dave");

    const res = await fetch(`${base}/users/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bio: "nope" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("PATCH /users/me returns 401 with an invalid token", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const res = await fetch(`${base}/users/me`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ bio: "nope" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});
