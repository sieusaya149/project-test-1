// Shared authentication helpers for the plain-JS frontend. No framework, no
// build step. The JWT is kept in localStorage under `token`.
const TOKEN_KEY = "token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function isLoggedIn() {
  return Boolean(getToken());
}

// Shows the log-in / sign-up links when logged out and the log-out link when
// logged in. Nav items opt in with data-auth="in" (only when logged in) or
// data-auth="out" (only when logged out).
function updateAuthNav() {
  const loggedIn = isLoggedIn();
  for (const el of document.querySelectorAll("[data-auth]")) {
    const wants = el.getAttribute("data-auth");
    el.hidden = wants === "in" ? !loggedIn : loggedIn;
  }
}

function logout() {
  clearToken();
  window.location.href = "/login.html";
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// POSTs the form fields as JSON and returns the parsed body, throwing an Error
// carrying the API's `error` message on a non-2xx response.
async function postForm(form, endpoint) {
  const fields = {};
  for (const [name, value] of new FormData(form).entries()) {
    fields[name] = value;
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  const body = await readJson(res);
  if (!res.ok) {
    throw new Error(body.error || "Something went wrong. Please try again.");
  }
  return body;
}

function setError(message) {
  const box = document.getElementById("form-error");
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
}

async function submitLogin(form) {
  const body = await postForm(form, "/auth/login");
  setToken(body.token);
  window.location.href = "/";
}

async function submitSignup(form) {
  await postForm(form, "/auth/signup");
  // The signup endpoint does not return a token, so log straight in and land on
  // the feed with the token stored.
  const login = await postForm(form, "/auth/login");
  setToken(login.token);
  window.location.href = "/";
}

document.addEventListener("DOMContentLoaded", () => {
  updateAuthNav();

  const logoutLink = document.getElementById("logout-link");
  if (logoutLink) {
    logoutLink.addEventListener("click", (event) => {
      event.preventDefault();
      logout();
    });
  }

  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("");
      try {
        await submitLogin(loginForm);
      } catch (err) {
        setError(err.message);
      }
    });
  }

  const signupForm = document.getElementById("signup-form");
  if (signupForm) {
    signupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setError("");
      try {
        await submitSignup(signupForm);
      } catch (err) {
        setError(err.message);
      }
    });
  }
});
