// Plain browser JS for the profile page: load a user's profile from
// GET /users/:username and, when the logged-in user is viewing their own
// profile, offer an edit form that saves through PATCH /users/me. No framework
// and no build step.

const USERS_ENDPOINT = "/users";
const ME_ENDPOINT = "/users/me";
const LOGIN_PATH = "/login.html";
const AUTH_TOKEN_KEY = "instaclone.token";

/** Reads the stored JWT, or null when the user is not logged in. */
function authToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Decodes a base64url string (the JWT payload segment). */
function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return atob(padded);
}

/** Returns the logged-in user's username from the JWT, or null. */
function currentUsername() {
  const token = authToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(token.split(".")[1]));
    return typeof payload.username === "string" ? payload.username : null;
  } catch {
    return null;
  }
}

/**
 * Which username the page should show: an explicit `?username=` param wins,
 * otherwise fall back to the logged-in user's own username.
 */
function targetUsername() {
  const param = new URLSearchParams(window.location.search).get("username");
  return param || currentUsername();
}

function goToLogin() {
  window.location.assign(LOGIN_PATH);
}

/** Builds the avatar element, falling back to an initial-letter placeholder. */
function avatarElement(profile) {
  if (profile.avatarUrl) {
    const img = document.createElement("img");
    img.className = "profile-avatar";
    img.src = profile.avatarUrl;
    img.alt = `Avatar for ${profile.username}`;
    return img;
  }
  const placeholder = document.createElement("div");
  placeholder.className = "profile-avatar profile-avatar-placeholder";
  placeholder.textContent = profile.username.charAt(0).toUpperCase();
  placeholder.setAttribute("aria-hidden", "true");
  return placeholder;
}

/** Renders the profile card (avatar, username, counts, bio) into `container`. */
function renderProfile(container, profile) {
  container.replaceChildren();

  const card = document.createElement("div");
  card.className = "profile-card";

  card.appendChild(avatarElement(profile));

  const info = document.createElement("div");
  info.className = "profile-info";

  const username = document.createElement("h2");
  username.className = "profile-username";
  username.textContent = `@${profile.username}`;
  info.appendChild(username);

  const stats = document.createElement("p");
  stats.className = "profile-stats";
  stats.textContent =
    `${profile.posts} posts · ${profile.followers} followers · ` +
    `${profile.following} following`;
  info.appendChild(stats);

  if (profile.bio) {
    const bio = document.createElement("p");
    bio.className = "profile-bio";
    bio.textContent = profile.bio;
    info.appendChild(bio);
  }

  card.appendChild(info);
  container.appendChild(card);
}

/** Renders a simple status message (loading / error / logged-out / not found). */
function renderStatus(container, message) {
  container.replaceChildren();
  const p = document.createElement("p");
  p.className = "profile-status";
  p.textContent = message;
  container.appendChild(p);
}

/** Shows and pre-fills the edit form only when viewing your own profile. */
function showEditForm(profile) {
  const section = document.getElementById("edit-profile");
  if (!section) return;

  const me = currentUsername();
  if (!me || me !== profile.username) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const avatarInput = document.getElementById("avatar-url");
  const bioInput = document.getElementById("bio");
  if (avatarInput) avatarInput.value = profile.avatarUrl ?? "";
  if (bioInput) bioInput.value = profile.bio ?? "";
}

function setEditError(message) {
  const box = document.getElementById("edit-error");
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
}

/** Saves the edit form through PATCH /users/me; returns the updated profile. */
async function saveProfile(form) {
  const token = authToken();
  if (!token) {
    goToLogin();
    return null;
  }

  const fields = {};
  for (const [name, value] of new FormData(form).entries()) {
    fields[name] = value;
  }

  const res = await fetch(ME_ENDPOINT, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(fields),
  });
  if (res.status === 401) {
    goToLogin(); // stale/expired token → log in again
    return null;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || "Couldn't save your profile.");
  }
  return body;
}

document.addEventListener("DOMContentLoaded", async () => {
  const container = document.getElementById("profile");
  if (!container) return;

  const username = targetUsername();
  if (!username) {
    renderStatus(container, "Log in to view your profile.");
    return;
  }

  renderStatus(container, "Loading…");
  try {
    const res = await fetch(`${USERS_ENDPOINT}/${encodeURIComponent(username)}`);
    if (res.status === 404) {
      renderStatus(container, "This user doesn't exist.");
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const profile = await res.json();
    renderProfile(container, profile);
    showEditForm(profile);
  } catch {
    renderStatus(container, "Couldn't load this profile.");
  }

  const form = document.getElementById("edit-profile-form");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setEditError("");
      try {
        const updated = await saveProfile(form);
        if (!updated) return; // already redirected to log in
        renderProfile(container, updated);
        showEditForm(updated);
      } catch (err) {
        setEditError(err.message);
      }
    });
  }
});
