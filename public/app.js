// Plain browser JS for the frontend shell: highlight the nav link that matches
// the current URL. No framework and no build step.
document.addEventListener("DOMContentLoaded", () => {
  const { pathname } = window.location;
  const links = document.querySelectorAll(".site-nav .nav-link");
  for (const link of links) {
    const href = link.getAttribute("href");
    if (href && (href === pathname || (href !== "/" && pathname.startsWith(href)))) {
      link.classList.add("is-active");
    }
  }
});
