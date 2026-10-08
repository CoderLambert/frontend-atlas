import type { NextConfig } from "next";

const localAppMode = process.env.FRONTEND_ATLAS_LOCAL_MODE === "1";
const publicLocalAppMode = process.env.NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE === "1";

if (localAppMode !== publicLocalAppMode) {
  throw new Error("The private and public Frontend Atlas runtime flags must match. Use npm run local:dev or npm run build.");
}

const nextConfig: NextConfig = {
  ...(localAppMode ? {} : { output: "export" as const }),
  pageExtensions: localAppMode ? ["js", "jsx", "ts", "tsx", "node.ts"] : ["js", "jsx", "ts", "tsx"],
  trailingSlash: true,
  // Keep Better Auth OAuth POST paths exact in the local server runtime.
  ...(localAppMode ? { skipTrailingSlashRedirect: true } : {}),
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
