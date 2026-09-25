# instagram-clone

An Instagram-like photo-sharing social network: accounts, photo posts, a home feed, likes, comments and follows.

Work is tracked in Jira project **IN** (https://huninna.atlassian.net/jira/software/projects/IN).
Branches and commits reference the Jira key, e.g. `IN-2`.

## Run

```sh
npm start          # http://localhost:3000/health
```

## Test

```sh
npm test           # node's built-in test runner; CI runs the same on every push and PR
npm run coverage   # same tests plus a coverage report; fails when line coverage < 80%
```
