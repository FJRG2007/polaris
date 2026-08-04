/**
 * Next.js configuration. Standalone output produces a self-contained server for
 * a small runtime image. The @polaris/* workspace packages ship as TypeScript
 * (ui) or are consumed as built dist; ui is transpiled here since it exports
 * source. Prisma is kept external so its engine binaries are not bundled.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import("next").NextConfig} */
const nextConfig = {
    output: "standalone",
    reactStrictMode: true,
    transpilePackages: ["@polaris/ui"],
    serverExternalPackages: ["@prisma/client", "@polaris/db", "@polaris/docker", "ssh2", "undici", "v9u-smb2"],
    // Trace from the monorepo root so the standalone server lands at the path the
    // Docker image expects (apps/web/.next/standalone/apps/web/server.js).
    outputFileTracingRoot: workspaceRoot,
    // The agent runtime bundle is served to runners as a file rather than imported,
    // so nothing in the graph references it and tracing would leave it out. A
    // missing bundle is a route that 404s and every dispatched run failing to
    // start, which is why it is named explicitly.
    outputFileTracingIncludes: {
        "/api/agents/runtime/bundle/**": ["../../packages/agent-runtime/dist/**"]
    },
    // Pages that moved under the app they belong to; the old top-level paths keep
    // working for anything already linking to them.
    redirects: async () => [
        { source: "/notifications", destination: "/account/notifications", permanent: true },
        { source: "/overview", destination: "/drive/overview", permanent: true }
    ],
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
