/**
 * A static export for GitHub Pages. The site is served under the repository's
 * name (`/polaris`) unless `SITE_BASE_PATH` says otherwise: empty for a custom
 * domain, which the workflow passes when the Pages site has one.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const basePath = process.env.SITE_BASE_PATH ?? "/polaris";
// The workspace root, so the build does not pick a lockfile above the checkout.
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import("next").NextConfig} */
export default {
    output: "export",
    outputFileTracingRoot: workspaceRoot,
    basePath: basePath || undefined,
    trailingSlash: true,
    images: { unoptimized: true },
    transpilePackages: ["@polaris/ui"],
    env: { NEXT_PUBLIC_BASE_PATH: basePath },
    eslint: { ignoreDuringBuilds: true }
};
