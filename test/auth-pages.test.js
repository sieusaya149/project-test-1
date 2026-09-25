import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

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

test("GET /login.html serves the log in page with email and password fields", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/login.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const body = await res.text();
    assert.ok(body.includes("<h1>Log in</h1>"), "page should have a Log in heading");
    assert.ok(body.includes('name="email"'), "page should have an email input");
    assert.ok(
      body.includes('name="password"'),
      "page should have a password input",
    );
    assert.ok(
      !body.includes('name="username"'),
      "log in page should not ask for a username",
    );
    assert.ok(body.includes("/auth.js"), "page should load the auth script");
  } finally {
    await close();
  }
});

test("GET /signup.html serves the sign up page with email, username and password fields", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/signup.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const body = await res.text();
    assert.ok(body.includes("<h1>Sign up</h1>"), "page should have a Sign up heading");
    assert.ok(body.includes('name="email"'), "page should have an email input");
    assert.ok(body.includes('name="username"'), "page should have a username input");
    assert.ok(
      body.includes('name="password"'),
      "page should have a password input",
    );
    assert.ok(body.includes("/auth.js"), "page should load the auth script");
  } finally {
    await close();
  }
});

test("GET /auth.js serves the auth script wired to the signup and login APIs", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/auth.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("/auth/login"), "auth script should call POST /auth/login");
    assert.ok(body.includes("/auth/signup"), "auth script should call POST /auth/signup");
    assert.ok(body.includes("localStorage"), "auth script should use localStorage");
    assert.ok(
      body.includes("removeItem"),
      "auth script should clear the token on log out",
    );
  } finally {
    await close();
  }
});
