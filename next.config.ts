import type { NextConfig } from "next";

const localAppMode = process.env.FRONTEND_ATLAS_LOCAL_MODE === "1";
const publicLocalAppMode = process.env.NEXT_PUBLIC_FRONTEND_ATLAS_LOCAL_MODE === "1";
const hostedDeployment = process.env.FRONTEND_ATLAS_DEPLOYMENT_MODE === "hosted";
const publicHostedDeployment = process.env.NEXT_PUBLIC_FRONTEND_ATLAS_DEPLOYMENT_MODE === "hosted";

if (localAppMode !== publicLocalAppMode) {
  throw new Error("The private and public Frontend Atlas runtime flags must match. Use npm run local:dev or npm run build.");
}
if (hostedDeployment !== publicHostedDeployment || (hostedDeployment && !localAppMode)) {
  throw new Error("The private and public deployment flags must match. Use the deployment Docker build entrypoint.");
}

const nextConfig: NextConfig = {
  ...(localAppMode ? {} : { output: "export" as const }),
  pageExtensions: localAppMode ? ["js", "jsx", "ts", "tsx", "node.ts"] : ["js", "jsx", "ts", "tsx"],
  trailingSlash: true,
  // Keep Better Auth OAuth POST paths exact in the local server runtime.
  ...(localAppMode ? { skipTrailingSlashRedirect: true } : {}),
  images: { unoptimized: true },
  poweredByHeader: false,
  ...(localAppMode ? { experimental: { authInterrupts: true } } : {}),
};

export default nextConfig;
