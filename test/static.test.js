import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/app.js";

/** Sends a raw request with the exact path (no URL normalization on our side). */
function rawRequest(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET / serves the frontend index.html with the app name and nav", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const body = await res.text();
    assert.ok(body.includes("InstaClone"), "page should include the app name");
    for (const label of ["Feed", "New post", "Profile", "Log in"]) {
      assert.ok(body.includes(label), `nav should include "${label}"`);
    }
  } finally {
    server.close();
  }
});

test("a static file under public/ is served with the correct content type", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/styles.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/css/);
  } finally {
    server.close();
  }
});

test("GET /app.js serves the browser script with the right content type", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);
  } finally {
    server.close();
  }
});

test("a path traversal outside public/ is refused", async () => {
  const server = createApp().listen(0);
  try {
    // Literal `..` and an encoded form that survives URL parsing and only
    // decodes to `..` inside our handler; both must never reach the filesystem.
    for (const path of ["/../package.json", "/%2e%2e%2fpackage.json"]) {
      const res = await rawRequest(server, path);
      assert.equal(res.status, 404, `${path} should be refused`);
      assert.ok(
        !res.body.includes("instagram-clone"),
        `${path} must not leak package.json`,
      );
    }
  } finally {
    server.close();
  }
});
