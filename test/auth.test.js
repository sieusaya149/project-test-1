import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
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

async function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /auth/signup creates a user with email and username", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const res = await post(base, "/auth/signup", {
      email: "alice@example.com",
      username: "alice",
      password: "password123",
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.email, "alice@example.com");
    assert.equal(body.username, "alice");
    assert.equal(body.password, undefined);
    assert.equal(body.passwordHash, undefined);
  } finally {
    await close();
  }
});

test("POST /auth/signup rejects a duplicate email", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const first = await post(base, "/auth/signup", {
      email: "bob@example.com",
      username: "bob",
      password: "password123",
    });
    assert.equal(first.status, 201);

    const dup = await post(base, "/auth/signup", {
      email: "bob@example.com",
      username: "bob2",
      password: "password123",
    });
    assert.equal(dup.status, 409);
  } finally {
    await close();
  }
});

test("POST /auth/signup rejects a duplicate username", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const first = await post(base, "/auth/signup", {
      email: "carol@example.com",
      username: "carol",
      password: "password123",
    });
    assert.equal(first.status, 201);

    const dup = await post(base, "/auth/signup", {
      email: "carol2@example.com",
      username: "carol",
      password: "password123",
    });
    assert.equal(dup.status, 409);
  } finally {
    await close();
  }
});

test("POST /auth/signup requires email, username and password", async () => {
  const { base, close } = await startApp(createApp());
  try {
    const res = await post(base, "/auth/signup", { username: "x", password: "y" });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /auth/login returns a JWT for valid credentials", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await post(base, "/auth/signup", {
      email: "dave@example.com",
      username: "dave",
      password: "correct-horse",
    });

    const res = await post(base, "/auth/login", {
      email: "dave@example.com",
      password: "correct-horse",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.token, "token should be present");

    const decoded = jwt.verify(body.token, "test-secret");
    assert.equal(decoded.sub, "dave@example.com");
    assert.equal(decoded.username, "dave");
  } finally {
    await close();
  }
});

test("POST /auth/login returns 401 for invalid credentials", async () => {
  const { base, close } = await startApp(createApp());
  try {
    await post(base, "/auth/signup", {
      email: "erin@example.com",
      username: "erin",
      password: "correct-horse",
    });

    const wrongPassword = await post(base, "/auth/login", {
      email: "erin@example.com",
      password: "wrong-password",
    });
    assert.equal(wrongPassword.status, 401);

    const unknownEmail = await post(base, "/auth/login", {
      email: "nobody@example.com",
      password: "correct-horse",
    });
    assert.equal(unknownEmail.status, 401);
  } finally {
    await close();
  }
});

test("passwords are stored hashed, never in plain text", async () => {
  const store = createUserStore();
  const { base, close } = await startApp(createApp({ users: store }));
  try {
    const password = "s3cret-password";
    const res = await post(base, "/auth/signup", {
      email: "hash@example.com",
      username: "hasher",
      password,
    });
    assert.equal(res.status, 201);

    const record = store.findByEmail("hash@example.com");
    assert.ok(record, "user should be stored");
    assert.equal(record.password, undefined);
    assert.notEqual(record.passwordHash, password);
    assert.match(record.passwordHash, /^\$2[aby]\$/); // bcrypt hash
    assert.equal(await bcrypt.compare(password, record.passwordHash), true);
  } finally {
    await close();
  }
});
