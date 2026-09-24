import { createServer } from "node:http";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { createUserStore } from "./store.js";

// Dev-only fallback so the app boots without configuration. Real deployments
// must set JWT_SECRET in the environment.
const DEV_JWT_SECRET = "dev-only-secret-change-me";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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

/** Builds the HTTP server; routes are added here as Jira stories land. */
export function createApp({ users } = {}) {
  const store = users ?? createUserStore();

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { status: "ok" });
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
        sendJson(res, 401, { error: "invalid credentials" });
        return;
      }

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

    sendJson(res, 404, { error: "not found" });
  });
}
