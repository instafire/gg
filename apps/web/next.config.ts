import type { NextConfig } from "next";

const apiBase =
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000";

const nextConfig: NextConfig = {
  // E2E runs build into a separate dist dir so the staging `.next` that the
  // live service serves from is never clobbered (see e2e/README.md).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Workspace packages ship compiled dist output; transpiling keeps
  // Next's module resolution aligned with the monorepo.
  transpilePackages: ["@gg/ui", "@gg/shared", "@gg/sdk"],
  images: {
    // Avatars/media are served by the GG API / object storage; the web app
    // renders them unoptimized at the component level.
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  async rewrites() {
    return [
      // Media files are served by the API (`GET /media/:id/:variant`, HLS,
      // captions). Proxy them through the web origin so the path-absolute
      // URLs the API emits work in the browser in every environment.
      { source: "/media/:path*", destination: `${apiBase}/media/:path*` },
    ];
  },
};

export default nextConfig;
