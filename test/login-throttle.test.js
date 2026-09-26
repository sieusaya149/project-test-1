import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

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

async function signup(base, email, username) {
  const res = await post(base, "/auth/signup", {
    email,
    username,
    password: "correct-horse",
  });
  assert.equal(res.status, 201);
}

async function login(base, email, password) {
  return post(base, "/auth/login", { email, password });
}

test("the 6th failed log-in for an email returns 429", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "locked@example.com", "locked");

    for (let i = 0; i < 5; i += 1) {
      const res = await login(base, "locked@example.com", "wrong-password");
      assert.equal(res.status, 401);
    }

    const sixth = await login(base, "locked@example.com", "wrong-password");
    assert.equal(sixth.status, 429);
    const body = await sixth.json();
    assert.match(body.error, /too many failed/i);
  } finally {
    await close();
  }
});

test("a successful log-in resets the failed-attempt count", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "reset@example.com", "resetter");

    for (let i = 0; i < 5; i += 1) {
      const res = await login(base, "reset@example.com", "wrong-password");
      assert.equal(res.status, 401);
    }

    const ok = await login(base, "reset@example.com", "correct-horse");
    assert.equal(ok.status, 200);

    // A fresh failure after the successful log-in starts the count over.
    const again = await login(base, "reset@example.com", "wrong-password");
    assert.equal(again.status, 401);
  } finally {
    await close();
  }
});

test("one email's failed log-ins do not affect another email", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await signup(base, "first@example.com", "first");
    await signup(base, "second@example.com", "second");

    for (let i = 0; i < 5; i += 1) {
      const res = await login(base, "first@example.com", "wrong-password");
      assert.equal(res.status, 401);
    }
    const sixth = await login(base, "first@example.com", "wrong-password");
    assert.equal(sixth.status, 429);

    // The other email is untouched and still sees the normal 401 flow.
    const other = await login(base, "second@example.com", "wrong-password");
    assert.equal(other.status, 401);

    // And it can still log in successfully while the first email is throttled.
    const ok = await login(base, "second@example.com", "correct-horse");
    assert.equal(ok.status, 200);
  } finally {
    await close();
  }
});
