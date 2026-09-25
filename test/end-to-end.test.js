import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

// End-to-end smoke test of the main flow (IN-19): sign up, log in, upload a
// photo post, see it in the feed (GET /posts), like it, and read the author's
// profile. It drives a real server on a random (OS-assigned) port and closes it
// when done, so it is self-cleaning.

process.env.JWT_SECRET = "end-to-end-test-secret";

/** Boots the app on an ephemeral port and returns helpers + a close() that waits. */
async function startServer() {
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

async function postJson(base, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("the main flow works end to end against a real server", async () => {
  const { base, close } = await startServer();
  try {
    // 1. Sign up.
    const signupRes = await postJson(base, "/auth/signup", {
      email: "nadia@example.com",
      username: "nadia",
      password: "s3cret-pass",
    });
    assert.equal(signupRes.status, 201, "signup should create the account");
    const signupBody = await signupRes.json();
    assert.equal(signupBody.email, "nadia@example.com");
    assert.equal(signupBody.username, "nadia");

    // 2. Log in and keep the JWT for the authenticated steps.
    const loginRes = await postJson(base, "/auth/login", {
      email: "nadia@example.com",
      password: "s3cret-pass",
    });
    assert.equal(loginRes.status, 200, "login should succeed");
    const { token } = await loginRes.json();
    assert.ok(token, "login should return a JWT");

    // 3. Create a post with an image.
    const createRes = await fetch(`${base}/posts?caption=${encodeURIComponent("golden hour")}`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        authorization: `Bearer ${token}`,
      },
      body: Buffer.from("fake-png-image-bytes"),
    });
    assert.equal(createRes.status, 201, "posting an image should succeed");
    const post = await createRes.json();
    assert.equal(post.imageUrl, `/posts/${post.id}/image`);
    assert.equal(post.caption, "golden hour");
    assert.equal(post.author, "nadia");
    assert.equal(post.likeCount, 0);

    // 4. See it in GET /posts.
    const feedRes = await fetch(`${base}/posts`);
    assert.equal(feedRes.status, 200);
    const feed = await feedRes.json();
    assert.ok(Array.isArray(feed), "GET /posts should return an array");
    const inFeed = feed.find((p) => p.id === post.id);
    assert.ok(inFeed, "the new post should appear in GET /posts");
    assert.equal(inFeed.caption, "golden hour");
    assert.equal(inFeed.author, "nadia");
    assert.equal(inFeed.likeCount, 0);

    // 5. Like it.
    const likeRes = await fetch(`${base}/posts/${post.id}/like`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(likeRes.status, 200, "liking should succeed");
    const likeBody = await likeRes.json();
    assert.equal(likeBody.liked, true);
    assert.equal(likeBody.likeCount, 1);

    // 6. Read the author's profile — the post should bump the posts count.
    const profileRes = await fetch(`${base}/users/nadia`);
    assert.equal(profileRes.status, 200);
    const profile = await profileRes.json();
    assert.equal(profile.username, "nadia");
    assert.equal(profile.posts, 1);
    assert.equal(profile.followers, 0);
    assert.equal(profile.following, 0);
  } finally {
    await close();
  }
});
