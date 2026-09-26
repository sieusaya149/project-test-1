/** In-memory post store. Persistence lands in a later story. */
export function createPostStore() {
  const posts = new Map();
  let nextId = 1;
  let nextCommentId = 1;

  return {
    add({ author, caption = "" }) {
      const id = String(nextId++);
      const post = {
        id,
        imageUrl: `/posts/${id}/image`,
        caption,
        author,
        likeCount: 0,
        commentCount: 0,
        likedBy: new Set(),
        comments: [],
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
    /** Likes a post. Idempotent; returns the new like count. */
    like(id, username) {
      const post = posts.get(id);
      if (!post) return null;
      if (!post.likedBy.has(username)) {
        post.likedBy.add(username);
        post.likeCount += 1;
      }
      return post.likeCount;
    },
    /** Unlikes a post. Idempotent; returns the new like count. */
    unlike(id, username) {
      const post = posts.get(id);
      if (!post) return null;
      if (post.likedBy.has(username)) {
        post.likedBy.delete(username);
        post.likeCount -= 1;
      }
      return post.likeCount;
    },
    /** Adds a comment; returns the stored comment, or null for an unknown post. */
    addComment(id, { author, text }) {
      const post = posts.get(id);
      if (!post) return null;
      const comment = { id: String(nextCommentId++), author, text };
      post.comments.push(comment);
      post.commentCount = post.comments.length;
      return comment;
    },
  };
}

/** In-memory user store. Persistence lands in a later story. */
export function createUserStore() {
  const usersByEmail = new Map();
  const usersByUsername = new Map();
  // username -> Set<username> of the users that username follows.
  const following = new Map();

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
    /** Returns every username in insertion order. */
    usernames() {
      return [...usersByUsername.keys()];
    },
    isFollowing(follower, followee) {
      return following.get(follower)?.has(followee) ?? false;
    },
    /** Returns the usernames `username` follows, as an array. */
    followingList(username) {
      return [...(following.get(username) ?? [])];
    },
    /** Follows `followee` from `follower`. Idempotent; bumps both counts. */
    follow(follower, followee) {
      const followerUser = usersByUsername.get(follower);
      const followeeUser = usersByUsername.get(followee);
      if (!followerUser || !followeeUser) {
        return false;
      }
      let edges = following.get(follower);
      if (!edges) {
        edges = new Set();
        following.set(follower, edges);
      }
      if (edges.has(followee)) {
        return true; // already following
      }
      edges.add(followee);
      followeeUser.followers += 1;
      followerUser.following += 1;
      return true;
    },
    /** Unfollows `followee` from `follower`. Idempotent; decrements both counts. */
    unfollow(follower, followee) {
      const followerUser = usersByUsername.get(follower);
      const followeeUser = usersByUsername.get(followee);
      if (!followerUser || !followeeUser) {
        return false;
      }
      const edges = following.get(follower);
      if (!edges || !edges.has(followee)) {
        return true; // not following
      }
      edges.delete(followee);
      followeeUser.followers -= 1;
      followerUser.following -= 1;
      return true;
    },
  };
}
