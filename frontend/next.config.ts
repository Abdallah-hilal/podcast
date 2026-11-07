import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for Docker image: pack only the runtime files instead of relying
  // on `next start` with the full node_modules tree.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
