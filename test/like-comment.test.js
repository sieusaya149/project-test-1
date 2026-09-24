import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createPostStore } from "../src/store.js";

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

async function postImage(base, token, caption) {
  const query = caption === undefined ? "" : `?caption=${encodeURIComponent(caption)}`;
  return fetch(`${base}/posts${query}`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      authorization: `Bearer ${token}`,
    },
    body: Buffer.from("fake-png-bytes"),
  });
}

async function like(base, token, postId, method = "POST") {
  return fetch(`${base}/posts/${postId}/like`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function comment(base, token, postId, text) {
  return fetch(`${base}/posts/${postId}/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text }),
  });
}

async function getPost(base, postId) {
  const res = await fetch(`${base}/posts/${postId}`);
  assert.equal(res.status, 200);
  return res.json();
}

test("POST /posts/:id/like likes a post and the count shows on GET /posts/:id", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    const created = await postImage(base, alice, "first post");
    assert.equal(created.status, 201);
    const post = await created.json();

    const res = await like(base, bob, post.id);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { liked: true, likeCount: 1 });

    const fetched = await getPost(base, post.id);
    assert.equal(fetched.likeCount, 1);
  } finally {
    await close();
  }
});

test("liking a post twice is idempotent (no double count)", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    const post = await (await postImage(base, alice)).json();

    assert.equal((await like(base, bob, post.id)).status, 200);
    assert.equal((await like(base, bob, post.id)).status, 200);

    const fetched = await getPost(base, post.id);
    assert.equal(fetched.likeCount, 1);
  } finally {
    await close();
  }
});

test("DELETE /posts/:id/like unlikes a post, idempotently", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    const post = await (await postImage(base, alice)).json();

    assert.equal((await like(base, bob, post.id)).status, 200);

    const res = await like(base, bob, post.id, "DELETE");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { liked: false, likeCount: 0 });

    // Unliking again must not go negative.
    assert.equal((await like(base, bob, post.id, "DELETE")).status, 200);

    const fetched = await getPost(base, post.id);
    assert.equal(fetched.likeCount, 0);
  } finally {
    await close();
  }
});

test("POST /posts/:id/comments adds a comment and increments commentCount", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    const post = await (await postImage(base, alice)).json();

    const res = await comment(base, bob, post.id, "nice shot!");
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.author, "bob");
    assert.equal(created.text, "nice shot!");
    assert.ok(created.id, "comment should have an id");

    const fetched = await getPost(base, post.id);
    assert.equal(fetched.commentCount, 1);

    const second = await comment(base, alice, post.id, "thanks!");
    assert.equal(second.status, 201);

    assert.equal((await getPost(base, post.id)).commentCount, 2);
  } finally {
    await close();
  }
});

test("comments must be 1-500 characters", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    const alice = await login(base, "alice@example.com");
    const post = await (await postImage(base, alice)).json();

    const empty = await comment(base, alice, post.id, "");
    assert.equal(empty.status, 400);

    const whitespace = await comment(base, alice, post.id, "   ");
    assert.equal(whitespace.status, 400);

    const tooLong = await comment(base, alice, post.id, "a".repeat(501));
    assert.equal(tooLong.status, 400);

    // Boundary values are accepted.
    assert.equal((await comment(base, alice, post.id, "a")).status, 201);
    assert.equal((await comment(base, alice, post.id, "b".repeat(500))).status, 201);

    assert.equal((await getPost(base, post.id)).commentCount, 2);
  } finally {
    await close();
  }
});

test("like, unlike and comment on an unknown post return 404", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    const alice = await login(base, "alice@example.com");

    assert.equal((await like(base, alice, "999")).status, 404);
    assert.equal((await like(base, alice, "999", "DELETE")).status, 404);
    assert.equal((await comment(base, alice, "999", "hi")).status, 404);

    const getRes = await fetch(`${base}/posts/999`);
    assert.equal(getRes.status, 404);
  } finally {
    await close();
  }
});

test("like, unlike and comment require authentication", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    const alice = await login(base, "alice@example.com");
    const post = await (await postImage(base, alice)).json();

    assert.equal(
      (await fetch(`${base}/posts/${post.id}/like`, { method: "POST" })).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/posts/${post.id}/like`, { method: "DELETE" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/posts/${post.id}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        })
      ).status,
      401,
    );
  } finally {
    await close();
  }
});

test("post responses (create, feed, single post) include like and comment counts", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    const alice = await login(base, "alice@example.com");

    const createdRes = await postImage(base, alice, "hello");
    assert.equal(createdRes.status, 201);
    const created = await createdRes.json();
    assert.equal(created.likeCount, 0);
    assert.equal(created.commentCount, 0);

    const single = await getPost(base, created.id);
    assert.equal(single.likeCount, 0);
    assert.equal(single.commentCount, 0);

    const feedRes = await fetch(`${base}/posts`);
    assert.equal(feedRes.status, 200);
    const feed = await feedRes.json();
    assert.equal(feed.length, 1);
    assert.equal(feed[0].id, created.id);
    assert.equal(feed[0].likeCount, 0);
    assert.equal(feed[0].commentCount, 0);
  } finally {
    await close();
  }
});

test("createPostStore tracks likes and comments idempotently", () => {
  const posts = createPostStore();
  const post = posts.add({ author: "alice", caption: "hi" });

  assert.equal(post.likeCount, 0);
  assert.equal(post.commentCount, 0);

  assert.equal(posts.like(post.id, "bob"), 1);
  assert.equal(posts.like(post.id, "bob"), 1); // idempotent
  assert.equal(posts.like(post.id, "carol"), 2);

  assert.equal(posts.unlike(post.id, "bob"), 1);
  assert.equal(posts.unlike(post.id, "bob"), 1); // idempotent
  assert.equal(posts.unlike(post.id, "carol"), 0);

  const comment = posts.addComment(post.id, { author: "bob", text: "nice" });
  assert.equal(comment.author, "bob");
  assert.equal(comment.text, "nice");
  assert.equal(post.commentCount, 1);

  assert.equal(posts.addComment(post.id, { author: "carol", text: "+1" }).id !== comment.id, true);
  assert.equal(post.commentCount, 2);
});
