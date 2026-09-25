import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

// IN-21: every served page must meet the same accessibility baseline — a
// <title>, a <main> landmark, a lang attribute on <html>, a label for every
// input, and alt text on every image. Pages are enumerated straight from
// public/ so a page added later is covered automatically.
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const HTML_PAGES = readdirSync(PUBLIC_DIR)
  .filter((file) => file.endsWith(".html"))
  .sort();

/** Value of `name` on an HTML start tag's attribute string, or null. */
function attribute(attrs, name) {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = re.exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/** True when the document has a non-empty <title>. */
function hasTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return Boolean(match && match[1].trim());
}

/** True when the document has a <main> landmark. */
function hasMain(html) {
  return /<main\b/i.test(html);
}

/** True when <html> carries a non-empty lang attribute. */
function htmlHasLang(html) {
  const match = /<html\b([^>]*)>/i.exec(html);
  if (!match) return false;
  return Boolean(attribute(match[1], "lang"));
}

/**
 * Returns every <input> with no associated <label>. An input is considered
 * labelled either by a <label for="id"> referencing it or by being nested
 * directly inside a <label>.
 */
function inputsWithoutLabel(html) {
  // Ids referenced by <label for="..."> anywhere in the document.
  const labeledIds = new Set();
  const forRe = /<label\b([^>]*)>/gi;
  let labelMatch;
  while ((labelMatch = forRe.exec(html))) {
    const forValue = attribute(labelMatch[1], "for");
    if (forValue !== null) labeledIds.add(forValue);
  }

  const unlabeled = [];
  // Walk labels and inputs in document order, tracking nesting depth so a
  // wrapped input counts as labelled even without a `for` attribute.
  const walkRe = /<label\b[^>]*>|<\/label>|<input\b[^>]*>/gi;
  let depth = 0;
  let token;
  while ((token = walkRe.exec(html))) {
    const tag = token[0];
    if (/^<label\b/i.test(tag)) {
      depth += 1;
    } else if (/^<\/label>/i.test(tag)) {
      if (depth > 0) depth -= 1;
    } else {
      const id = attribute(tag, "id");
      if (depth === 0 && !(id !== null && labeledIds.has(id))) {
        unlabeled.push(tag);
      }
    }
  }
  return unlabeled;
}

/** Every <img> missing an alt attribute (empty alt is valid for decoration). */
function imagesWithoutAlt(html) {
  const missing = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let match;
  while ((match = imgRe.exec(html))) {
    if (attribute(match[1], "alt") === null) missing.push(match[0]);
  }
  return missing;
}

test("public/ contains at least one HTML page to check", () => {
  assert.ok(HTML_PAGES.length > 0, "expected HTML pages under public/");
});

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }),
);

for (const page of HTML_PAGES) {
  test(`${page} meets the accessibility checks`, async () => {
    const path = page === "index.html" ? "/" : `/${page}`;
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${page} should be served`);
    assert.match(res.headers.get("content-type"), /text\/html/);

    const html = await res.text();
    assert.ok(hasTitle(html), `${page}: missing a non-empty <title>`);
    assert.ok(hasMain(html), `${page}: missing a <main> landmark`);
    assert.ok(htmlHasLang(html), `${page}: <html> is missing a lang attribute`);

    const unlabeled = inputsWithoutLabel(html);
    assert.deepEqual(
      unlabeled,
      [],
      `${page}: inputs without a label: ${unlabeled.join(", ")}`,
    );

    const noAlt = imagesWithoutAlt(html);
    assert.deepEqual(
      noAlt,
      [],
      `${page}: images without alt: ${noAlt.join(", ")}`,
    );
  });
}
