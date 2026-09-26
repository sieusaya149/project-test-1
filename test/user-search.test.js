import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

process.env.JWT_SECRET = "user-search-test-secret";

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

async function signup(base, email, username, password = "password123") {
  const res = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, username, password }),
  });
  assert.equal(res.status, 201, `signup for ${username} should succeed`);
}

// ---- API: GET /users?q= ----

test("GET /users?q= returns usernames containing the query, case-insensitively", async () => {
  const { base, close } = await startApp();
  try {
    await signup(base, "alice@example.com", "alice");
    await signup(base, "bob@example.com", "bob");
    await signup(base, "carol@example.com", "carol");

    const res = await fetch(`${base}/users?q=ali`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ username: "alice" }]);

    // Case-insensitive: an upper-case query matches the lower-case username.
    const upper = await fetch(`${base}/users?q=ALICE`);
    assert.equal(upper.status, 200);
    assert.deepEqual(await upper.json(), [{ username: "alice" }]);

    // A query matching several usernames returns them in insertion order.
    const broad = await fetch(`${base}/users?q=o`);
    assert.equal(broad.status, 200);
    assert.deepEqual(await broad.json(), [
      { username: "bob" },
      { username: "carol" },
    ]);
  } finally {
    await close();
  }
});

test("GET /users?q= returns an empty list when nothing matches", async () => {
  const { base, close } = await startApp();
  try {
    await signup(base, "alice@example.com", "alice");

    const res = await fetch(`${base}/users?q=zzz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    await close();
  }
});

test("GET /users with a missing or empty q returns nothing", async () => {
  const { base, close } = await startApp();
  try {
    await signup(base, "alice@example.com", "alice");

    for (const path of ["/users", "/users?q=", "/users?q=%20%20"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} should be a valid search`);
      assert.deepEqual(await res.json(), [], `${path} should match nothing`);
    }
  } finally {
    await close();
  }
});

test("GET /users?q= caps results at 20 matches", async () => {
  const { base, close } = await startApp();
  try {
    for (let i = 0; i < 25; i += 1) {
      await signup(base, `user${i}@example.com`, `user${String(i).padStart(2, "0")}`);
    }

    const res = await fetch(`${base}/users?q=user`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 20, "should return at most 20 matches");
    assert.deepEqual(
      body.map((u) => u.username),
      Array.from({ length: 20 }, (_, i) => `user${String(i).padStart(2, "0")}`),
      "the first 20 matches in insertion order",
    );
  } finally {
    await close();
  }
});

// ---- Served page + wiring ----

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const HTML_PAGES = readdirSync(PUBLIC_DIR)
  .filter((file) => file.endsWith(".html"))
  .sort();

test("every served page carries the search box and loads /search.js", async () => {
  const { base, close } = await startApp();
  try {
    for (const page of HTML_PAGES) {
      const path = page === "index.html" ? "/" : `/${page}`;
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${page} should be served`);
      const body = await res.text();

      assert.ok(
        body.includes('id="search-form"'),
        `${page}: should include the search form`,
      );
      assert.ok(
        body.includes('id="search-input"'),
        `${page}: should include the search input`,
      );
      assert.ok(
        body.includes('for="search-input"'),
        `${page}: the search input should have a label`,
      );
      assert.ok(
        body.includes("/search.js"),
        `${page}: should load the search script`,
      );
    }
  } finally {
    await close();
  }
});

test("GET /search.js is wired to GET /users?q= and links to profile pages", async () => {
  const { base, close } = await startApp();
  try {
    const res = await fetch(`${base}/search.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);

    const body = await res.text();
    assert.ok(body.includes("/users"), "search script should query /users");
    assert.ok(body.includes("/profile.html"), "search script should link to profiles");
    assert.ok(body.includes("username="), "search script should pass the username");
    assert.ok(
      body.includes("encodeURIComponent"),
      "search script should encode the query and username",
    );
  } finally {
    await close();
  }
});

// Behaviour-level coverage for the search script. search.js is a plain browser
// script (no imports/exports), so we evaluate it in a VM with a minimal DOM and
// drive renderSearchResults directly.

const SEARCH_JS = readFileSync(
  fileURLToPath(new URL("../public/search.js", import.meta.url)),
  "utf8",
);

function makeElement(tagName = "") {
  return {
    tagName,
    className: "",
    href: "",
    textContent: "",
    hidden: false,
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
  };
}

async function setupSearch() {
  const context = {
    console,
    encodeURIComponent,
    document: {
      createElement: (tag) => makeElement(tag),
      addEventListener() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${SEARCH_JS}\n;globalThis.__search = { renderSearchResults };`,
    context,
  );
  return context.__search;
}

test("renderSearchResults turns matches into links to their profile pages", async () => {
  const search = await setupSearch();
  const container = makeElement();

  search.renderSearchResults(container, [
    { username: "alice" },
    { username: "bob smith" },
  ]);

  assert.equal(container.hidden, false);
  const list = container.children[0];
  assert.equal(list.tagName, "ul");
  assert.equal(list.children.length, 2);

  const links = list.children.map((item) => item.children[0]);
  assert.equal(links[0].tagName, "a");
  assert.equal(links[0].href, "/profile.html?username=alice");
  assert.equal(links[0].textContent, "@alice");
  assert.equal(links[1].href, "/profile.html?username=bob%20smith");
  assert.equal(links[1].textContent, "@bob smith");
});

test("renderSearchResults hides the dropdown when there are no matches", async () => {
  const search = await setupSearch();
  const container = makeElement();

  search.renderSearchResults(container, []);

  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
});
