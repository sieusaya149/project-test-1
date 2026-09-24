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

async function postImage(base, token, caption) {
  const query = caption === undefined ? "" : `?caption=${encodeURIComponent(caption)}`;
  const res = await fetch(`${base}/posts${query}`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      authorization: `Bearer ${token}`,
    },
    body: Buffer.from("fake-png-bytes"),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function follow(base, token, username) {
  const res = await fetch(`${base}/users/${username}/follow`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
}

async function getFeed(base, token, cursor) {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(`${base}/feed${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("GET /feed returns at most 20 posts per page, newest first, with a working cursor", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    await follow(base, alice, "bob");

    for (let i = 0; i < 25; i += 1) {
      await postImage(base, bob, `post ${i + 1}`);
    }

    const first = await getFeed(base, alice);
    assert.equal(first.posts.length, 20);
    assert.equal(typeof first.nextCursor, "string");

    // Newest first: the 25th post has the highest id and must lead the page.
    assert.equal(first.posts[0].id, "25");
    assert.equal(first.posts[19].id, "6");
    assert.equal(first.nextCursor, "6");

    const second = await getFeed(base, alice, first.nextCursor);
    assert.equal(second.posts.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(second.posts[0].id, "5");
    assert.equal(second.posts[4].id, "1");

    // The two pages together cover all 25 posts exactly once.
    const ids = [...first.posts, ...second.posts].map((p) => p.id);
    assert.equal(ids.length, 25);
    assert.equal(new Set(ids).size, 25);
  } finally {
    await close();
  }
});

test("GET /feed only includes posts from followed users and my own", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    await signup(base, "dave@example.com", "dave");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");
    const dave = await login(base, "dave@example.com");

    await follow(base, alice, "bob");

    await postImage(base, alice, "my own post");
    await postImage(base, bob, "followed post");
    await postImage(base, dave, "not followed post");

    const feed = await getFeed(base, alice);
    const authors = feed.posts.map((p) => p.author).sort();

    assert.deepEqual(authors, ["alice", "bob"]);
    assert.equal(feed.posts.some((p) => p.author === "dave"), false);
  } finally {
    await close();
  }
});

test("pages never repeat a post, including across a refresh of the first page", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    await follow(base, alice, "bob");

    for (let i = 0; i < 45; i += 1) {
      await postImage(base, bob, `post ${i + 1}`);
    }

    // Refreshing the first page returns the same cursor, so fetching it again
    // then paging through must not yield any duplicate post ids.
    const first = await getFeed(base, alice);
    const firstAgain = await getFeed(base, alice);
    assert.deepEqual(first, firstAgain);

    const second = await getFeed(base, alice, first.nextCursor);
    const third = await getFeed(base, alice, second.nextCursor);

    const ids = [...first.posts, ...second.posts, ...third.posts].map((p) => p.id);
    assert.equal(ids.length, 45);
    assert.equal(new Set(ids).size, 45);
    assert.equal(third.posts.length, 5);
    assert.equal(third.nextCursor, null);
  } finally {
    await close();
  }
});

test("pull-to-refresh after paging never re-serves a post (IN-10)", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    const alice = await login(base, "alice@example.com");
    const bob = await login(base, "bob@example.com");

    await follow(base, alice, "bob");

    for (let i = 0; i < 25; i += 1) {
      await postImage(base, bob, `post ${i + 1}`);
    }

    // 1. Open the feed, then scroll to page 2.
    const first = await getFeed(base, alice);
    assert.equal(first.posts.length, 20);
    const second = await getFeed(base, alice, first.nextCursor);
    assert.equal(second.posts.length, 5);

    // 2. A new post arrives while the user is paging. With an offset/limit
    //    cursor this shifts page boundaries; the anchor must stay stable.
    await postImage(base, bob, "post 26 (arrives before refresh)");

    // 3. Pull to refresh re-fetches page 1.
    const refreshed = await getFeed(base, alice);

    // 4. Scroll to page 2 again using the refreshed cursor.
    const secondAgain = await getFeed(base, alice, refreshed.nextCursor);

    const page1Ids = refreshed.posts.map((p) => p.id);
    const page2Ids = secondAgain.posts.map((p) => p.id);

    // The newest post of page 1 must never reappear on page 2.
    assert.equal(page2Ids.includes(page1Ids[0]), false);

    // The two refreshed pages together cover all 26 posts exactly once.
    const allIds = [...page1Ids, ...page2Ids];
    assert.equal(allIds.length, 26);
    assert.equal(new Set(allIds).size, 26);
    assert.equal(secondAgain.posts.length, 6);
    assert.equal(secondAgain.nextCursor, null);
  } finally {
    await close();
  }
});

test("GET /feed requires authentication", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const res = await fetch(`${base}/feed`);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("createUserStore.followingList reports who a user follows", () => {
  const store = createUserStore();
  store.add({ email: "alice@example.com", username: "alice", passwordHash: "x" });
  store.add({ email: "bob@example.com", username: "bob", passwordHash: "x" });
  store.add({ email: "carol@example.com", username: "carol", passwordHash: "x" });

  assert.deepEqual(store.followingList("alice"), []);

  store.follow("alice", "bob");
  store.follow("alice", "carol");
  assert.deepEqual(store.followingList("alice").sort(), ["bob", "carol"]);

  store.unfollow("alice", "bob");
  assert.deepEqual(store.followingList("alice"), ["carol"]);
});
