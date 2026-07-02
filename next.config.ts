import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "assets.ads.airankia.com" },
    ],
  },
  // ── Merge: serve gads-sentinel (the Performance/Security optimizer) INSIDE
  // ads.airankia.com under /performance. Same-origin reverse-proxy — the shared
  // .airankia.com Supabase cookie is forwarded, so no re-login. We STRIP the
  // /performance prefix here; sentinel re-adds it to its generated links via its
  // SENTINEL_BASE_PATH middleware, so every link stays under /performance.
  async rewrites() {
    return [
      { source: "/performance", destination: "https://googleads.airankia.com/" },
      {
        source: "/performance/:path*",
        destination: "https://googleads.airankia.com/:path*",
      },
    ];
  },
};

export default nextConfig;
