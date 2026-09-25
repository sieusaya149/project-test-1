import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";

const { version: packageVersion } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("GET /health reports status and the package.json version", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.version, packageVersion);
  } finally {
    server.close();
  }
});

test("an unknown route is 404", async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
