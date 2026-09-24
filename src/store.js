/** In-memory post store. Persistence lands in a later story. */
export function createPostStore() {
  const posts = new Map();
  let nextId = 1;

  return {
    add({ author, caption = "" }) {
      const id = String(nextId++);
      const post = {
        id,
        imageUrl: `/posts/${id}/image`,
        caption,
        author,
      };
      posts.set(id, post);
      return post;
    },
    list() {
      return [...posts.values()];
    },
    findById(id) {
      return posts.get(id);
    },
  };
}

/** In-memory user store. Persistence lands in a later story. */
export function createUserStore() {
  const usersByEmail = new Map();
  const usersByUsername = new Map();

  return {
    hasEmail(email) {
      return usersByEmail.has(email);
    },
    hasUsername(username) {
      return usersByUsername.has(username);
    },
    add(user) {
      if (usersByEmail.has(user.email) || usersByUsername.has(user.username)) {
        return false;
      }
      const record = {
        email: user.email,
        username: user.username,
        passwordHash: user.passwordHash,
        avatarUrl: user.avatarUrl ?? "",
        bio: user.bio ?? "",
        posts: user.posts ?? 0,
        followers: user.followers ?? 0,
        following: user.following ?? 0,
      };
      usersByEmail.set(record.email, record);
      usersByUsername.set(record.username, record);
      return true;
    },
    findByEmail(email) {
      return usersByEmail.get(email);
    },
    findByUsername(username) {
      return usersByUsername.get(username);
    },
  };
}
