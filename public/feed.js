// Plain browser JS for the feed page: fetch posts from the API and render them
// newest first. Each post carries a like button that likes/unlikes through the
// API, updates the count immediately, and reverts it if the request fails.
// No framework and no build step.

const POSTS_ENDPOINT = "/posts";
const LOGIN_PATH = "/login.html";
const AUTH_TOKEN_KEY = "instaclone.token";

// Post ids the current user has liked this session. The public /posts feed does
// not expose per-user like state, so this starts empty and toggles in the UI.
const likedPosts = new Set();
// Post ids with a like/unlike request in flight, to avoid double-submits.
const pendingLikes = new Set();

/** Reads the stored JWT, or null when the user is not logged in. */
function authToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function goToLogin() {
  window.location.assign(LOGIN_PATH);
}

/** Paints the button from the post's current like state. */
function renderLikeButton(button, post) {
  const liked = likedPosts.has(post.id);
  button.textContent = `${liked ? "♥" : "♡"} ${post.likeCount}`;
  button.classList.toggle("is-liked", liked);
  button.setAttribute("aria-pressed", String(liked));
  button.setAttribute("aria-label", liked ? "Unlike this post" : "Like this post");
}

/** Builds the like/unlike button for one post. */
function likeButton(post) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "like-button";
  renderLikeButton(button, post);
  button.addEventListener("click", () => toggleLike(post, button));
  return button;
}

/** Likes/unlikes a post optimistically, reverting the count if the request fails. */
async function toggleLike(post, button) {
  const token = authToken();
  if (!token) {
    goToLogin();
    return;
  }
  if (pendingLikes.has(post.id)) {
    return;
  }

  const wasLiked = likedPosts.has(post.id);
  const previousCount = post.likeCount;
  const method = wasLiked ? "DELETE" : "POST";

  // Optimistic update: reflect the change immediately.
  if (wasLiked) {
    likedPosts.delete(post.id);
    post.likeCount = Math.max(0, post.likeCount - 1);
  } else {
    likedPosts.add(post.id);
    post.likeCount += 1;
  }
  renderLikeButton(button, post);

  pendingLikes.add(post.id);
  button.disabled = true;
  try {
    const res = await fetch(`${POSTS_ENDPOINT}/${post.id}/like`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      handleUnauthorized(); // expired/invalid token → clear it and log in again
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    // The server's likeCount is authoritative.
    post.likeCount = data.likeCount;
    if (data.liked) {
      likedPosts.add(post.id);
    } else {
      likedPosts.delete(post.id);
    }
    renderLikeButton(button, post);
  } catch {
    // Revert the optimistic update.
    post.likeCount = previousCount;
    if (wasLiked) {
      likedPosts.add(post.id);
    } else {
      likedPosts.delete(post.id);
    }
    renderLikeButton(button, post);
  } finally {
    pendingLikes.delete(post.id);
    button.disabled = false;
  }
}

/** Builds the <article> element for a single post. */
function postElement(post) {
  const article = document.createElement("article");
  article.className = "post";

  const header = document.createElement("header");
  header.className = "post-header";
  const author = document.createElement("span");
  author.className = "post-author";
  author.textContent = `@${post.author}`;
  header.appendChild(author);
  article.appendChild(header);

  const img = document.createElement("img");
  img.className = "post-image";
  img.src = post.imageUrl;
  img.alt = `Post by ${post.author}`;
  img.loading = "lazy";
  article.appendChild(img);

  const body = document.createElement("div");
  body.className = "post-body";

  if (post.caption) {
    const caption = document.createElement("p");
    caption.className = "post-caption";
    caption.textContent = post.caption;
    body.appendChild(caption);
  }

  const meta = document.createElement("p");
  meta.className = "post-meta";

  const comments = document.createElement("span");
  comments.className = "post-comments";
  comments.textContent = `💬 ${post.commentCount}`;

  meta.append(likeButton(post), " ", comments);
  body.appendChild(meta);
  article.appendChild(body);

  return article;
}

/** Replaces the feed container with the empty state or the rendered posts. */
function renderFeed(container, posts) {
  container.replaceChildren();

  if (posts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "feed-empty";
    empty.textContent = "No posts yet.";
    container.appendChild(empty);
    return;
  }

  // GET /posts returns posts oldest-first; the feed shows newest first.
  const newestFirst = [...posts].sort((a, b) => Number(b.id) - Number(a.id));
  const list = document.createElement("div");
  list.className = "feed-list";
  for (const post of newestFirst) {
    list.appendChild(postElement(post));
  }
  container.appendChild(list);
}

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("feed");
  if (!container) return;

  // Loading state while the request is in flight.
  container.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "feed-status";
  loading.textContent = "Loading…";
  container.appendChild(loading);

  fetch(POSTS_ENDPOINT)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    })
    .then((posts) => renderFeed(container, posts))
    .catch(() => {
      container.replaceChildren();
      const error = document.createElement("p");
      error.className = "feed-status";
      error.textContent = "Couldn't load posts.";
      container.appendChild(error);
    });
});
