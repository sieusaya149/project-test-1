import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createUserStore } from "../src/store.js";

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

async function follow(base, token, username, method = "POST") {
  return fetch(`${base}/users/${username}/follow`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function getProfile(base, username) {
  const res = await fetch(`${base}/users/${username}`);
  assert.equal(res.status, 200);
  return res.json();
}

test("POST /users/:username/follow follows a user and updates both counts immediately", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const token = await login(base, "alice@example.com");

    const res = await follow(base, token, "bob");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { following: true });

    assert.equal((await getProfile(base, "alice")).following, 1);
    assert.equal((await getProfile(base, "bob")).followers, 1);
  } finally {
    await close();
  }
});

test("DELETE /users/:username/follow unfollows a user and updates both counts immediately", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const token = await login(base, "alice@example.com");

    assert.equal((await follow(base, token, "bob")).status, 200);

    const res = await follow(base, token, "bob", "DELETE");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { following: false });

    assert.equal((await getProfile(base, "alice")).following, 0);
    assert.equal((await getProfile(base, "bob")).followers, 0);
  } finally {
    await close();
  }
});

test("a user cannot follow themselves", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    const token = await login(base, "alice@example.com");

    const res = await follow(base, token, "alice");
    assert.equal(res.status, 400);

    assert.equal((await getProfile(base, "alice")).following, 0);
    assert.equal((await getProfile(base, "alice")).followers, 0);
  } finally {
    await close();
  }
});

test("following an unknown username returns 404", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    const token = await login(base, "alice@example.com");

    const res = await follow(base, token, "ghost");
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("follow and unfollow require authentication", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");

    const postRes = await fetch(`${base}/users/bob/follow`, { method: "POST" });
    assert.equal(postRes.status, 401);

    const deleteRes = await fetch(`${base}/users/bob/follow`, { method: "DELETE" });
    assert.equal(deleteRes.status, 401);
  } finally {
    await close();
  }
});

test("POST follow is idempotent (re-following does not double-count)", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const token = await login(base, "alice@example.com");

    assert.equal((await follow(base, token, "bob")).status, 200);
    assert.equal((await follow(base, token, "bob")).status, 200);

    assert.equal((await getProfile(base, "alice")).following, 1);
    assert.equal((await getProfile(base, "bob")).followers, 1);
  } finally {
    await close();
  }
});

test("DELETE unfollow is idempotent (unfollowing twice does not go negative)", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const token = await login(base, "alice@example.com");

    assert.equal((await follow(base, token, "bob")).status, 200);
    assert.equal((await follow(base, token, "bob", "DELETE")).status, 200);
    assert.equal((await follow(base, token, "bob", "DELETE")).status, 200);

    assert.equal((await getProfile(base, "alice")).following, 0);
    assert.equal((await getProfile(base, "bob")).followers, 0);
  } finally {
    await close();
  }
});

test("createUserStore tracks the follow graph idempotently", () => {
  const store = createUserStore();
  store.add({ email: "alice@example.com", username: "alice", passwordHash: "x" });
  store.add({ email: "bob@example.com", username: "bob", passwordHash: "x" });

  assert.equal(store.isFollowing("alice", "bob"), false);
  assert.equal(store.follow("alice", "bob"), true);
  assert.equal(store.isFollowing("alice", "bob"), true);
  assert.equal(store.follow("alice", "bob"), true); // idempotent

  const alice = store.findByUsername("alice");
  const bob = store.findByUsername("bob");
  assert.equal(alice.following, 1);
  assert.equal(bob.followers, 1);

  assert.equal(store.unfollow("alice", "bob"), true);
  assert.equal(store.isFollowing("alice", "bob"), false);
  assert.equal(store.unfollow("alice", "bob"), true); // idempotent
  assert.equal(alice.following, 0);
  assert.equal(bob.followers, 0);
});
