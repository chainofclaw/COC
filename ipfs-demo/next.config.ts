import type { NextConfig } from "next";

const IPFS_HOST = process.env.IPFS_API_HOST ?? "http://127.0.0.1:5001";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/ipfs-api/:path*",
        destination: `${IPFS_HOST}/api/v0/:path*`,
      },
      {
        source: "/ipfs-gw/:path*",
        destination: `${IPFS_HOST}/ipfs/:path*`,
      },
    ];
  },
};

export default nextConfig;
