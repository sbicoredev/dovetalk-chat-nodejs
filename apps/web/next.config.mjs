import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the API is, as seen from the web server (not from the browser). Used when the browser
// calls the API through this app's own /api path. Read at build time: the rewrite is baked into
// the build, so change it with a rebuild.
const apiProxyTarget = process.env.API_PROXY_TARGET?.trim().replace(/\/+$/u, "");

if (process.env.NEXT_PUBLIC_API_URL?.trim().startsWith("/") && !apiProxyTarget) {
  throw new Error(
    "NEXT_PUBLIC_API_URL is a path on this site, so API_PROXY_TARGET must say where the API is (for example http://localhost:3001).",
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@dovetalk/contracts"],

  // A self-contained server for the Docker image (`NEXT_STANDALONE=1`). It lives in a monorepo,
  // so the files it needs are traced from the repository root.
  ...(process.env.NEXT_STANDALONE === "1"
    ? {
        output: "standalone",
        outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      }
    : {}),

  // Serves the API under this app's own origin: /api/auth/refresh reaches the API's
  // /auth/refresh. The refresh cookie then belongs to the same site as the page, so browsers
  // that block third-party cookies still send it. (The socket cannot go through here: it
  // connects to the API directly, with the access token. See NEXT_PUBLIC_WS_URL.)
  async rewrites() {
    return apiProxyTarget
      ? [{ source: "/api/:path*", destination: `${apiProxyTarget}/:path*` }]
      : [];
  },
};

export default nextConfig;
