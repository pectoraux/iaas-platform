import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel doesn't need standalone output. Keep it off for Vercel deploys.
  // For Docker/space-z.ai, standalone can be re-enabled.
  output: undefined,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
