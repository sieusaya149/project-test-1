// Plain browser JS for the New post page: pick a JPEG or PNG, write a caption
// and POST /posts with the logged-in user's token. Files of any other type, or
// over 10 MB, are refused here in the page before any upload. No framework, no
// build step.

const POSTS_ENDPOINT = "/posts";
const LOGIN_PATH = "/login.html";
const AUTH_TOKEN_KEY = "instaclone.token";
const MAX_POST_BYTES = 10 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

/** Reads the stored JWT, or null when the user is not logged in. */
function authToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function setError(message) {
  const box = document.getElementById("form-error");
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
}

/** Returns a clear refusal message for an invalid file, or null when it's ok. */
function fileError(file) {
  if (!file) {
    return "Choose a photo to post.";
  }
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    return "Only JPEG and PNG images can be posted.";
  }
  if (file.size > MAX_POST_BYTES) {
    return "That photo is over 10 MB — pick a smaller one.";
  }
  return null;
}

/**
 * Uploads `file` to POST /posts with the given caption and token. Returns
 * `{ posted }` and reports failures through `setError`; a 401 or a missing
 * token sends the user back to log in.
 */
async function submitNewPost({
  token,
  file,
  caption,
  fetchImpl = fetch,
  goToFeed = () => window.location.assign("/"),
  goToLogin = () => window.location.assign(LOGIN_PATH),
  setError,
}) {
  if (!token) {
    goToLogin(LOGIN_PATH);
    return { posted: false };
  }

  const error = fileError(file);
  if (error) {
    setError(error);
    return { posted: false };
  }

  const url = caption
    ? `${POSTS_ENDPOINT}?caption=${encodeURIComponent(caption)}`
    : POSTS_ENDPOINT;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": file.type, authorization: `Bearer ${token}` },
      body: file,
    });

    if (res.status === 401) {
      goToLogin(LOGIN_PATH);
      return { posted: false };
    }

    if (!res.ok) {
      let message = "Couldn't post. Please try again.";
      try {
        const body = await res.json();
        if (body && body.error) {
          message = body.error;
        }
      } catch {
        // Non-JSON error body: keep the generic message.
      }
      setError(message);
      return { posted: false };
    }

    goToFeed("/");
    return { posted: true };
  } catch {
    setError("Couldn't post. Please try again.");
    return { posted: false };
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("new-post-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");

    const token = authToken();
    const file = form.elements.image && form.elements.image.files[0];
    const caption = (form.elements.caption.value || "").trim();
    const submit = form.querySelector('button[type="submit"]');

    submit.disabled = true;
    try {
      await submitNewPost({ token, file, caption, setError });
    } finally {
      submit.disabled = false;
    }
  });
});
