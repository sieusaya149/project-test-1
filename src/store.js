/** In-memory user store. Persistence lands in a later story. */
export function createUserStore() {
  const usersByEmail = new Map();
  const usernames = new Set();

  return {
    hasEmail(email) {
      return usersByEmail.has(email);
    },
    hasUsername(username) {
      return usernames.has(username);
    },
    add(user) {
      if (usersByEmail.has(user.email) || usernames.has(user.username)) {
        return false;
      }
      usersByEmail.set(user.email, user);
      usernames.add(user.username);
      return true;
    },
    findByEmail(email) {
      return usersByEmail.get(email);
    },
  };
}
