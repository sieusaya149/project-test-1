// Plain browser JS for the header search box: as the user types, query
// GET /users?q=... and render the matching usernames as links to their profile
// pages. No framework and no build step.

const SEARCH_ENDPOINT = "/users";
const PROFILE_PAGE = "/profile.html";

/**
 * Renders the search matches into `container` as links to each user's profile
 * page. An empty result set hides the container.
 */
function renderSearchResults(container, users) {
  container.replaceChildren();
  if (!Array.isArray(users) || users.length === 0) {
    container.hidden = true;
    return;
  }

  const list = document.createElement("ul");
  list.className = "search-results-list";
  for (const user of users) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "search-result-link";
    link.href = `${PROFILE_PAGE}?username=${encodeURIComponent(user.username)}`;
    link.textContent = `@${user.username}`;
    item.appendChild(link);
    list.appendChild(item);
  }
  container.appendChild(list);
  container.hidden = false;
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  if (!form || !input || !results) return;

  // Abort controller so a slow, stale response never overwrites newer results.
  let controller = null;

  async function runSearch(query) {
    const q = typeof query === "string" ? query.trim() : "";
    if (!q) {
      if (controller) controller.abort();
      results.hidden = true;
      results.replaceChildren();
      return;
    }

    if (controller) controller.abort();
    controller = new AbortController();
    try {
      const res = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const users = await res.json();
      renderSearchResults(results, users);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      results.hidden = true;
      results.replaceChildren();
    }
  }

  input.addEventListener("input", () => runSearch(input.value));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(input.value);
  });

  // Dismiss the dropdown when clicking anywhere outside the search form.
  document.addEventListener("click", (event) => {
    if (!form.contains(event.target)) {
      results.hidden = true;
    }
  });
});
