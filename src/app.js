import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { createUserStore, createPostStore } from "./store.js";

// Read the app version straight from package.json so the health endpoint never
// hardcodes it (and can't drift from the published version).
const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

// The web frontend lives under public/ and is served straight off disk. It is a
// plain HTML/CSS/JS shell (no framework, no build step) so the API can serve it
// directly.
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

// Dev-only fallback so the app boots without configuration. Real deployments
// must set JWT_SECRET in the environment.
const DEV_JWT_SECRET = "dev-only-secret-change-me";

const MAX_POST_BYTES = 10 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

// Failed log-in throttling: an email that racks up more than this many failures
// within the window below is told to back off with a 429.
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Maps a URL pathname to an absolute path inside public/, or null when it points
 * outside public/ (path traversal) or fails to decode. `pathname` comes from
 * `new URL(...).pathname`, which already strips literal `..` segments, so the
 * decode + segment check here guards against encoded traversal like `%2e%2e%2f`.
 */
function publicFilePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (rel.split(/[/\\]/).includes("..")) return null;

  const abs = resolve(PUBLIC_DIR, rel);
  const within = relative(PUBLIC_DIR, abs);
  if (within === "" || within.split(/[/\\]/)[0] === "..") return null;
  return abs;
}

/** Reads the raw request body, capping memory at `maxBytes`. */
async function readRawBody(req, { maxBytes } = {}) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (tooLarge) {
      continue; // drain the rest of the stream without buffering it
    }
    size += chunk.length;
    if (maxBytes !== undefined && size > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  return { tooLarge, body: Buffer.concat(chunks) };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    return {};
  }
  return JSON.parse(raw);
}

function jwtSecret() {
  return process.env.JWT_SECRET ?? DEV_JWT_SECRET;
}

/** Returns the verified JWT payload, or null when the request is unauthenticated. */
function authenticate(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    return null;
  }
  try {
    return jwt.verify(match[1], jwtSecret());
  } catch {
    return null;
  }
}

/** The public profile shape shared by GET /users/:username and PATCH /users/me. */
function publicProfile(user) {
  return {
    username: user.username,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    posts: user.posts,
    followers: user.followers,
    following: user.following,
  };
}

/** The public post shape shared by POST /posts, GET /posts and GET /posts/:id. */
function publicPost(post) {
  return {
    id: post.id,
    imageUrl: post.imageUrl,
    caption: post.caption,
    author: post.author,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
  };
}

/** Builds the HTTP server; routes are added here as Jira stories land. */
export function createApp({ users, posts } = {}) {
  const store = users ?? createUserStore();
  const postStore = posts ?? createPostStore();

  // email -> timestamps (ms) of failed log-in attempts inside the current
  // window. In-memory only; one email's failures never touch another's.
  const loginFailures = new Map();

  /** Records a failed log-in and returns how many failures are now in-window. */
  function recordLoginFailure(email) {
    const now = Date.now();
    const windowStart = now - LOGIN_FAILURE_WINDOW_MS;
    const recent = (loginFailures.get(email) ?? []).filter((t) => t > windowStart);
    recent.push(now);
    loginFailures.set(email, recent);
    return recent.length;
  }

  /** Clears a user's failed-attempt history (called on a successful log-in). */
  function resetLoginFailures(email) {
    loginFailures.delete(email);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" || req.method === "HEAD") {
      const filePath = publicFilePath(path);
      if (filePath) {
        let stat = null;
        try {
          stat = statSync(filePath);
        } catch {
          // missing file -> fall through to the 404 below
        }
        if (stat && stat.isFile()) {
          const contentType =
            STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ??
            "application/octet-stream";
          const body = readFileSync(filePath);
          res.writeHead(200, {
            "content-type": contentType,
            "content-length": body.length,
          });
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }
      }
    }

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { status: "ok", version: APP_VERSION });
      return;
    }

    if (req.method === "POST" && path === "/auth/signup") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }

      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const username =
        typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";

      if (!email || !username || !password) {
        sendJson(res, 400, {
          error: "email, username and password are required",
        });
        return;
      }

      if (store.hasEmail(email) || store.hasUsername(username)) {
        sendJson(res, 409, { error: "email or username already taken" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);
      store.add({ email, username, passwordHash });

      sendJson(res, 201, { email, username });
      return;
    }

    if (req.method === "POST" && path === "/auth/login") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }

      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";

      const user = store.findByEmail(email);
      const passwordOk =
        user && (await bcrypt.compare(password, user.passwordHash));

      if (!passwordOk) {
        const failures = recordLoginFailure(email);
        if (failures > LOGIN_FAILURE_LIMIT) {
          sendJson(res, 429, {
            error: "too many failed login attempts; try again later",
          });
          return;
        }
        sendJson(res, 401, { error: "invalid credentials" });
        return;
      }

      resetLoginFailures(email);

      const token = jwt.sign(
        { sub: user.email, username: user.username },
        jwtSecret(),
        { expiresIn: "1h" },
      );

      sendJson(res, 200, { token });
      return;
    }

    if (req.method === "GET" && path.startsWith("/users/")) {
      const raw = path.slice("/users/".length);
      let username;
      try {
        username = decodeURIComponent(raw);
      } catch {
        username = raw;
      }

      const user = store.findByUsername(username);
      if (!user) {
        sendJson(res, 404, { error: "user not found" });
        return;
      }

      sendJson(res, 200, publicProfile(user));
      return;
    }

    if (req.method === "PATCH" && path === "/users/me") {
      const token = authenticate(req);
      const user = token && store.findByEmail(token.sub);
      if (!user) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }

      const hasBio = Object.prototype.hasOwnProperty.call(body, "bio");
      const hasAvatarUrl = Object.prototype.hasOwnProperty.call(body, "avatarUrl");

      if (hasBio && typeof body.bio !== "string") {
        sendJson(res, 400, { error: "bio must be a string" });
        return;
      }
      if (hasAvatarUrl && typeof body.avatarUrl !== "string") {
        sendJson(res, 400, { error: "avatarUrl must be a string" });
        return;
      }
      if (!hasBio && !hasAvatarUrl) {
        sendJson(res, 400, { error: "bio or avatarUrl is required" });
        return;
      }

      if (hasBio) {
        user.bio = body.bio;
      }
      if (hasAvatarUrl) {
        user.avatarUrl = body.avatarUrl;
      }

      sendJson(res, 200, publicProfile(user));
      return;
    }

    const followMatch = /^\/users\/([^/]+)\/follow$/.exec(path);
    if (followMatch && (req.method === "POST" || req.method === "DELETE")) {
      const token = authenticate(req);
      const actor = token && store.findByEmail(token.sub);
      if (!actor) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      let username;
      try {
        username = decodeURIComponent(followMatch[1]);
      } catch {
        username = followMatch[1];
      }

      const target = store.findByUsername(username);
      if (!target) {
        sendJson(res, 404, { error: "user not found" });
        return;
      }

      if (actor.username === target.username) {
        sendJson(res, 400, { error: "cannot follow yourself" });
        return;
      }

      if (req.method === "POST") {
        store.follow(actor.username, target.username);
      } else {
        store.unfollow(actor.username, target.username);
      }

      sendJson(res, 200, {
        following: store.isFollowing(actor.username, target.username),
      });
      return;
    }

    if (req.method === "POST" && path === "/posts") {
      const token = authenticate(req);
      const user = token && store.findByEmail(token.sub);
      if (!user) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const contentType = (req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!ACCEPTED_IMAGE_TYPES.has(contentType)) {
        sendJson(res, 415, {
          error: "content type must be image/jpeg or image/png",
        });
        return;
      }

      const contentLength = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_POST_BYTES) {
        sendJson(res, 413, { error: "image exceeds 10 MB limit" });
        return;
      }

      const { tooLarge } = await readRawBody(req, { maxBytes: MAX_POST_BYTES });
      if (tooLarge) {
        sendJson(res, 413, { error: "image exceeds 10 MB limit" });
        return;
      }

      const caption = url.searchParams.get("caption") ?? "";
      const post = postStore.add({ author: user.username, caption });
      user.posts += 1;

      sendJson(res, 201, publicPost(post));
      return;
    }

    const likeMatch = /^\/posts\/([^/]+)\/like$/.exec(path);
    if (likeMatch && (req.method === "POST" || req.method === "DELETE")) {
      const token = authenticate(req);
      const user = token && store.findByEmail(token.sub);
      if (!user) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const post = postStore.findById(likeMatch[1]);
      if (!post) {
        sendJson(res, 404, { error: "post not found" });
        return;
      }

      const liked = req.method === "POST";
      if (liked) {
        postStore.like(post.id, user.username);
      } else {
        postStore.unlike(post.id, user.username);
      }

      sendJson(res, 200, { liked, likeCount: post.likeCount });
      return;
    }

    const commentsMatch = /^\/posts\/([^/]+)\/comments$/.exec(path);
    if (commentsMatch && req.method === "POST") {
      const token = authenticate(req);
      const user = token && store.findByEmail(token.sub);
      if (!user) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const post = postStore.findById(commentsMatch[1]);
      if (!post) {
        sendJson(res, 404, { error: "post not found" });
        return;
      }

      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }

      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length < 1 || text.length > 500) {
        sendJson(res, 400, { error: "comment must be 1-500 characters" });
        return;
      }

      const comment = postStore.addComment(post.id, {
        author: user.username,
        text,
      });
      sendJson(res, 201, comment);
      return;
    }

    if (req.method === "GET" && path === "/posts") {
      sendJson(res, 200, postStore.list().map(publicPost));
      return;
    }

    if (req.method === "GET" && path === "/feed") {
      const token = authenticate(req);
      const user = token && store.findByEmail(token.sub);
      if (!user) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const feedAuthors = new Set([
        user.username,
        ...store.followingList(user.username),
      ]);

      const feedPosts = postStore
        .list()
        .filter((post) => feedAuthors.has(post.author))
        .sort((a, b) => Number(b.id) - Number(a.id));

      // `?cursor=<id>` continues from the last post id seen; only strictly
      // older posts are returned so a page can never repeat a post.
      const cursorParam = url.searchParams.get("cursor");
      let before = Number.POSITIVE_INFINITY;
      if (cursorParam !== null) {
        const parsed = Number(cursorParam);
        if (Number.isInteger(parsed) && parsed >= 0) {
          before = parsed;
        }
      }

      const page = feedPosts.filter((post) => Number(post.id) < before);
      const FEED_PAGE_SIZE = 20;
      const result = page.slice(0, FEED_PAGE_SIZE);
      const nextCursor =
        page.length > FEED_PAGE_SIZE ? result[result.length - 1].id : null;

      sendJson(res, 200, {
        posts: result.map(publicPost),
        nextCursor,
      });
      return;
    }

    const postMatch = /^\/posts\/([^/]+)$/.exec(path);
    if (postMatch && req.method === "GET") {
      const post = postStore.findById(postMatch[1]);
      if (!post) {
        sendJson(res, 404, { error: "post not found" });
        return;
      }

      sendJson(res, 200, publicPost(post));
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });
}
