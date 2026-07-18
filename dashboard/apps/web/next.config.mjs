/**
 * Next.js configuration. Standalone output produces a self-contained server for
 * a small runtime image. The @polaris/* workspace packages ship as TypeScript
 * (ui) or are consumed as built dist; ui is transpiled here since it exports
 * source. Prisma is kept external so its engine binaries are not bundled.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import("next").NextConfig} */
const nextConfig = {
    output: "standalone",
    reactStrictMode: true,
    transpilePackages: ["@polaris/ui"],
    serverExternalPackages: ["@prisma/client", "@polaris/db", "@polaris/docker", "ssh2"],
    // Trace from the monorepo root so the standalone server lands at the path the
    // Docker image expects (apps/web/.next/standalone/apps/web/server.js).
    outputFileTracingRoot: workspaceRoot,
    webpack: (config) => {
        // @polaris/ui is transpiled from TypeScript source and, like the rest of
        // the repo, uses explicit .js import specifiers. Map them back to .ts/.tsx
        // so webpack resolves them the way tsc's bundler resolution does.
        config.resolve.extensionAlias = {
            ".js": [".ts", ".tsx", ".js"],
            ".jsx": [".tsx", ".jsx"]
        };
        return config;
    }
};

export default nextConfig;
