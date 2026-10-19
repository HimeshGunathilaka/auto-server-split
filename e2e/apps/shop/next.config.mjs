// The e2e harness copies this app inside the repository and sets AUTO_SPLIT_REPO_ROOT so
// Turbopack resolves next/react from the repository's node_modules.
const root = process.env.AUTO_SPLIT_REPO_ROOT;

/** @type {import("next").NextConfig} */
const config = {
  ...(root ? { turbopack: { root }, outputFileTracingRoot: root } : {}),
};

export default config;
