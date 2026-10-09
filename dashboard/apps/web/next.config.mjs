/**
 * Next.js configuration. Standalone output produces a self-contained server for
 * a small runtime image. The @polaris/* workspace packages ship as TypeScript
 * (ui) or are consumed as built dist; ui is transpiled here since it exports
 * source. Prisma is kept external so its engine binaries are not bundled.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PortableImportMetaUrl } from "./scripts/portable-import-meta.mjs";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every path except a published calendar's embed, in the matcher syntax Next uses
 *  for `headers()`. */
const FRAMEABLE_EXCEPT_EMBEDS = "/:path((?!cal/embed/).*)";

/**
 * The only sites a Polaris page may put in a frame: the chat's players
 * (`EMBED_FRAME_ORIGINS` in `src/lib/chat/embeds.ts`, which a test holds this
 * list to). Everything else Polaris frames is itself or a `srcdoc` document - a
 * mail body, a print preview - which `frame-src` does not govern. Written out
 * rather than imported because this file is read by Node before anything is
 * compiled.
 */
const PLAYER_ORIGINS = [
    "https://www.youtube-nocookie.com",
    "https://player.vimeo.com",
    "https://open.spotify.com",
    "https://www.tiktok.com",
    "https://www.instagram.com",
    "https://platform.twitter.com",
    "https://player.twitch.tv",
    "https://clips.twitch.tv",
    "https://w.soundcloud.com",
    "https://embed.reddit.com",
    "https://streamable.com",
    "https://www.dailymotion.com",
    "https://geo.dailymotion.com",
    "https://player.kick.com"
];

/** The CLI protocol versions this server speaks, oldest-newest. Written out
 *  rather than imported for the same reason as the list above; a test holds
 *  it to the CLI's own `CLI_PROTOCOL`. */
export const CLI_PROTOCOL_RANGE = "1-1";

/** @type {import("next").NextConfig} */
const nextConfig = {
    output: "standalone",
    reactStrictMode: true,
    experimental: { serverActions: { bodySizeLimit: "32mb" } },
    // CI's checks job runs ESLint over these same sources beside the app build, so
    // linting again inside `next build` proved nothing new. Skipped only where that
    // job is known to run: dashboard-ci.yml sets the flag on its build, and nothing
    // else does - the image and every local build still lint. The type check stays:
    // it also covers the route types Next generates under .next/types, which exist
    // only after a build, so the checks job's `tsc` never sees them.
    eslint: { ignoreDuringBuilds: process.env.POLARIS_BUILD_SKIP_LINT === "1" },
    transpilePackages: ["@polaris/ui", "@polaris/file-parse", "@polaris/app-host"],
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
        "/api/agents/runtime/bundle/**": ["../../packages/agent-runtime/dist/**"],
        // The command-line client and its install scripts, served by
        // `/cli/[file]` and imported by nothing - so named, or the image ships
        // without them and the install line downloads a 503.
        "/cli/**": ["../../packages/cli/dist/**", "../../packages/cli/scripts/**"]
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
        {
            source: "/integrations/:path*",
            destination: "/admin/integrations/:path*",
            permanent: false
        },
        { source: "/settings", destination: "/admin/settings", permanent: false },
        { source: "/settings/:path*", destination: "/admin/settings/:path*", permanent: false },
        { source: "/inbox", destination: "/admin/inbox", permanent: false },
        { source: "/inbox/:path*", destination: "/admin/inbox/:path*", permanent: false },
        { source: "/favorites", destination: "/drive/favorites", permanent: false },
        { source: "/trash", destination: "/drive/trash", permanent: false },
        // Screens that moved and used to forward from a page of their own.
        // A page in the signed-in group that only redirects is answered inside
        // that group's loading boundary, so on a first visit the redirect is
        // carried out mid-hydration - and that crashed the tab (see
        // src/app/page.tsx). Here it is a 307 before any page is drawn.
        //
        // Notes are their own app now; links to a note are written into other
        // notes, tasks and old chat messages, and the query is carried across,
        // so `?note=` still opens that note.
        { source: "/account/notes", destination: "/notes", permanent: false },
        // Reported messages are on the safety queue, beside reports about people.
        // The address is in bookmarks and in old alerts.
        { source: "/admin/reports", destination: "/admin/safety", permanent: false },
        // Model keys belong to the account, not to the Agents app. People
        // bookmark the screen they keep credentials on.
        { source: "/apps/agents/keys", destination: "/account/ai-keys", permanent: false },
        // A project's firewall is the firewall screen scoped to that project. The
        // destination refuses an id that is not the caller's with a 404, so
        // forwarding blindly says nothing about whether the project exists.
        {
            source: "/apps/deploy/:projectId/firewall",
            destination: "/apps/firewall?scope=project&id=:projectId",
            permanent: false
        }
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
    /**
     * Clickjacking: no other site may show Polaris inside a frame.
     *
     * Sent by the app rather than by the edge in front of it, because more than one
     * edge serves Polaris (Traefik's file route for the public names, compose labels
     * for the local ones, Caddy in development) and only the app knows which of its
     * pages are meant to be framed. `'self'` keeps every frame Polaris draws of
     * itself working - and the ones it draws today are `srcdoc` documents (mail
     * bodies, print previews), which carry no headers of their own anyway.
     *
     * The one exception is a published calendar's embed, `/cal/embed/<token>`, whose
     * whole purpose is to be framed by the operator's own website.
     *
     * The same policy says what Polaris itself may frame (`frame-src`): its own
     * pages and the chat's players, and nothing else - so a frame injected into a
     * page cannot load an arbitrary site inside Polaris.
     */
    headers: async () => [
        {
            source: FRAMEABLE_EXCEPT_EMBEDS,
            headers: [
                {
                    key: "Content-Security-Policy",
                    value: `frame-ancestors 'self'; frame-src 'self' ${PLAYER_ORIGINS.join(" ")}`
                },
                { key: "X-Frame-Options", value: "SAMEORIGIN" }
            ]
        },
        // The consent screen an AI assistant sends somebody to: not even Polaris
        // frames it. An Allow button that can be drawn inside another page is a
        // button that can be clicked through one. Later in the list, so these
        // values replace the ones above for this path.
        {
            source: "/oauth/authorize",
            headers: [
                {
                    key: "Content-Security-Policy",
                    value: `frame-ancestors 'none'; frame-src 'self' ${PLAYER_ORIGINS.join(" ")}`
                },
                { key: "X-Frame-Options", value: "DENY" }
            ]
        },
        // The CLI protocol versions this Polaris answers, `<oldest>-<newest>`,
        // on everything the CLI calls. The CLI is installed from GitHub and
        // updated on its own schedule, so it compares its own version with this
        // on every call and says whether to run `plr update` or update Polaris
        // (`packages/cli/src/compat.ts`). Raise the newest only for a change an
        // older CLI would misread; raise the oldest only when the server stops
        // answering an old CLI the old way.
        ...["/api/cli/:path*", "/api/v1/:path*"].map((source) => ({
            source,
            headers: [{ key: "X-Polaris-Cli-Protocol", value: CLI_PROTOCOL_RANGE }]
        }))
    ],
    rewrites: async () => [
        { source: "/vault/api/:path*", destination: "/api/bw/api/:path*" },
        { source: "/vault/identity/:path*", destination: "/api/bw/identity/:path*" },
        { source: "/vault/icons/:path*", destination: "/api/bw/icons/:path*" },
        { source: "/vault/notifications/:path*", destination: "/api/bw/notifications/:path*" },
        { source: "/vault/events/:path*", destination: "/api/bw/events/:path*" }
    ],
    webpack: (config, { isServer, webpack }) => {
        // @polaris/ui is transpiled from TypeScript source and, like the rest of
        // the repo, uses explicit .js import specifiers. Map them back to .ts/.tsx
        // so webpack resolves them the way tsc's bundler resolution does.
        config.resolve.extensionAlias = {
            ".js": [".ts", ".tsx", ".js"],
            ".jsx": [".tsx", ".jsx"]
        };
        // The canvas library the presentation viewer draws with can also run
        // outside a browser, and asks for Node's `canvas` package when it does.
        // Nothing here ever takes that path - the drawing happens in a tab - and
        // the package is a native build nobody should be compiling to serve a
        // .pptx. Resolved to nothing so the optional require stays optional.
        config.resolve.alias = { ...config.resolve.alias, canvas: false };
        // A bare `import.meta.url` would otherwise ship this machine's absolute
        // path to every browser (scripts/portable-import-meta.mjs), and the
        // postbuild check fails the build if any path still gets through.
        if (!isServer) config.plugins.push(new PortableImportMetaUrl(workspaceRoot, webpack));
        return config;
    }
};

export default nextConfig;
