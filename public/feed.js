// Plain browser JS for the feed page: fetch posts from the API and render them
// newest first. No framework and no build step.

const POSTS_ENDPOINT = "/posts";

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

  const likes = document.createElement("span");
  likes.className = "post-likes";
  likes.textContent = `♥ ${post.likeCount}`;

  const comments = document.createElement("span");
  comments.className = "post-comments";
  comments.textContent = `💬 ${post.commentCount}`;

  meta.append(likes, " ", comments);
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
