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
    serverExternalPackages: [
        "@prisma/client",
        "@polaris/db",
        "@polaris/docker",
        "ssh2",
        "undici",
        "v9u-smb2",
        // The two that draw a file's thumbnail. Both carry a compiled binary for
        // the platform they run on, and a bundler cannot put one of those inside
        // a JavaScript chunk - it stops the build rather than trying.
        //
        // `pdfjs-dist` deliberately is NOT here even though the same code uses
        // it: the viewer reaches it from the browser through another package,
        // and externalising it breaks that import instead.
        "sharp",
        "@napi-rs/canvas"
    ],
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
    // Pages that moved; the old paths keep working for anything already linking to
    // them. Two rules, and the second is why the first exists:
    //
    // A path listed here is claimed before routing, so it must never name a screen
    // that exists - /overview redirected to Drive's own overview until the landing
    // screen was built on that path, and the redirect went on answering for it.
    //
    // None of them is permanent. A permanent redirect is a 308, which a browser
    // caches with no expiry and consults before it asks the server anything: the
    // rule above can be deleted, deployed and still be what a returning session
    // gets, because that session never re-requests the path to find out it changed.
    // These are private pages with no search engine to inform, so the only thing
    // permanence buys here is an unfixable mistake. The landing screen now answers
    // at /home for the same reason - a path nobody's browser has a stale answer for.
    redirects: async () => [
        { source: "/notifications", destination: "/account/notifications", permanent: false },
        { source: "/overview", destination: "/home", permanent: false },
        // Home's screens were at /house for one release. Temporary on purpose: a
        // permanent redirect is a 308 with no expiry, cached by every browser
        // that ever followed it, and this project has already lost one path that
        // way.
        { source: "/house", destination: "/places", permanent: false },
        { source: "/house/:path*", destination: "/places/:path*", permanent: false },
        // Management's screens were spread between /admin and the top level, so
        // the URL said nothing about which part of Polaris you were in. They are
        // all under /admin now, and Drive's two stray screens under /drive.
        { source: "/integrations", destination: "/admin/integrations", permanent: false },
        { source: "/integrations/:path*", destination: "/admin/integrations/:path*", permanent: false },
        { source: "/settings", destination: "/admin/settings", permanent: false },
        { source: "/settings/:path*", destination: "/admin/settings/:path*", permanent: false },
        { source: "/inbox", destination: "/admin/inbox", permanent: false },
        { source: "/inbox/:path*", destination: "/admin/inbox/:path*", permanent: false },
        { source: "/favorites", destination: "/drive/favorites", permanent: false },
        { source: "/trash", destination: "/drive/trash", permanent: false }
    ],
    /**
     * The vault's Bitwarden-compatible surface.
     *
     * Official clients are given one server URL and derive the rest from it:
     * `<base>/api`, `<base>/identity`, `<base>/notifications`, `<base>/icons`,
     * `<base>/events`. Pointing them at `<origin>/vault` therefore means
     * answering on those five paths, and they cannot move - a client will not
     * be told otherwise.
     *
     * They are rewritten rather than served from `app/vault/api/...` because
     * `/vault` is also a page: a route group and a plain folder of the same name
     * at the same level is exactly the collision Next refuses to build. One
     * explicit list of prefixes keeps the page and the API from ever meeting.
     */
    rewrites: async () => [
        { source: "/vault/api/:path*", destination: "/api/bw/api/:path*" },
        { source: "/vault/identity/:path*", destination: "/api/bw/identity/:path*" },
        { source: "/vault/icons/:path*", destination: "/api/bw/icons/:path*" },
        { source: "/vault/notifications/:path*", destination: "/api/bw/notifications/:path*" },
        { source: "/vault/events/:path*", destination: "/api/bw/events/:path*" }
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
