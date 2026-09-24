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
        process.env.JWT_SECRET ?? DEV_JWT_SECRET,
        { expiresIn: "1h" },
      );

      sendJson(res, 200, { token });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });
}
