import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // type-check fuera del build: corre en GitHub Actions (no bloquea el deploy)
  typescript: { ignoreBuildErrors: true },
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "assets.ads.airankia.com" },
    ],
  },
};

export default nextConfig;
