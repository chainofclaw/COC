import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // solc is loaded at runtime via require() inside a worker thread, so static
  // analysis cannot see it. Keep it external and force it into the standalone
  // output trace for the verify route.
  serverExternalPackages: ["solc"],
  outputFileTracingIncludes: {
    "/api/verify": ["./node_modules/solc/**/*"],
  },
};

export default nextConfig;
