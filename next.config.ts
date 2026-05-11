import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin Turbopack's workspace root so it stops trying to infer one and
  // panicking with "Next.js package not found" when it picks a parent dir.
  turbopack: {
    root: path.resolve(__dirname),
  },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
