/**
 * What the firewall must never mistake for an attack: Polaris asking for its own
 * pages and files.
 *
 * The exploit packs and the probes jail look for paths such as `/phpmyadmin` and
 * `/wp-login`. Polaris's own Marketplace serves `/logos/apps/phpmyadmin.svg` and
 * `/apps/marketplace/template-phpmyadmin`, so somebody browsing it on the dashboard
 * read as a scanner, and three logos in a minute banned their address for a day.
 * Nothing under a route Polaris serves can be a probe for software Polaris does
 * not run: those requests are answered by Polaris itself, which serves no PHP, so
 * they are left to it.
 *
 * Pure and dependency-free: the edge guard and the dashboard both read it.
 */

/**
 * The first path segment of every route and public file the dashboard serves.
 * Kept equal to the app's own tree by a test that reads it
 * (`apps/web/test/firewall/polaris-route-roots.test.ts`), so a new top-level
 * page is added here or the build fails.
 */
export const POLARIS_ROUTE_ROOTS: readonly string[] = [
    "_next",
    ".well-known",
    "about",
    "account",
    "admin",
    "analytics",
    "analytics.js",
    "announcements",
    "api",
    "apple-touch-icon.png",
    "apps",
    "audio",
    "automations",
    "backgrounds",
    "bergamot",
    "c",
    "cal",
    "calendar",
    "chat",
    "cli",
    "crm",
    "diagram-assets",
    "drive",
    "edge",
    "f",
    "favicon.ico",
    "forms",
    "game-servers",
    "games",
    "home",
    "icon.svg",
    "images",
    "k",
    "legal",
    "logos",
    "m",
    "mail",
    "mail-server",
    "manifest.webmanifest",
    "marketplace",
    "n",
    "network-filter",
    "notes",
    "o",
    "oauth",
    "od",
    "office",
    "office-fonts",
    "offline.html",
    "p",
    "pdfjs",
    "places",
    "polar",
    "polaris-mark-128.png",
    "polaris-mark-192.png",
    "polaris-mark-512.png",
    "r",
    "robots.txt",
    "router",
    "s",
    "sounds",
    "status",
    "status-pages",
    "sw.js",
    "t",
    "tasks",
    "telemetry",
    "tools",
    "tr",
    "translate",
    "u",
    "vault",
    "video",
    "vpn",
    "vs",
    "wall",
    "watch"
];

const ROOTS = new Set(POLARIS_ROUTE_ROOTS);

/** The path alone, decoded where it can be, without its query. */
function pathOnly(path: string): string {
    const bare = path.split(/[?#]/, 1)[0] ?? "";
    try {
        return decodeURIComponent(bare);
    } catch {
        return bare;
    }
}

/**
 * Whether a path on the dashboard's own hostnames is one of Polaris's routes or
 * files. A path that climbs (`..`) is never one: it is the shape of an attempt to
 * get out of a route, not a route. Nor is one with a hidden segment below the
 * root (`/api/.env`, `/admin/.git/config`): Polaris has none, and a scanner
 * reaching for a secret under a real route is still a scanner.
 */
export function isPolarisOwnPath(path: string | null | undefined): boolean {
    if (!path) return false;
    const bare = pathOnly(path);
    if (!bare.startsWith("/") || bare.includes("..")) return false;
    const segments = bare.slice(1).split("/");
    if (segments.slice(1).some((segment) => segment.startsWith("."))) return false;
    return ROOTS.has(segments[0] ?? "");
}

/** Files a page loads to draw itself. A scanner looks for programs and secrets,
 *  never for a picture or a font. */
const ASSET_EXTENSIONS = new Set([
    "svg",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "avif",
    "ico",
    "bmp",
    "css",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "mp3",
    "mp4",
    "webm",
    "ogg",
    "wav"
]);

/** Whether a path names an image, a font, a stylesheet or media. */
export function isStaticAssetPath(path: string | null | undefined): boolean {
    if (!path) return false;
    const bare = pathOnly(path);
    const last = bare.slice(bare.lastIndexOf("/") + 1).toLowerCase();
    const dot = last.lastIndexOf(".");
    return dot > 0 && ASSET_EXTENSIONS.has(last.slice(dot + 1));
}

/**
 * Whether `marker` (`/phpmyadmin`, `/.git`, `/wp-login`) names a whole segment of
 * the path, rather than appearing inside one: `/phpmyadmin/` and `/phpMyAdmin`
 * do, `/logos/phpmyadmin.svg` and `/.github/` do not. What may follow the marker
 * is the end, a slash, or - for a marker that names a file stem - a dot that
 * starts a program's extension.
 */
export function pathHasSegment(path: string | null | undefined, marker: string): boolean {
    if (!path) return false;
    const bare = pathOnly(path).toLowerCase();
    const wanted = marker.toLowerCase().replace(/\/+$/, "");
    let from = 0;
    for (;;) {
        const at = bare.indexOf(wanted, from);
        if (at < 0) return false;
        const next = bare.charAt(at + wanted.length);
        if (next === "" || next === "/") return true;
        if (next === ".") {
            // The whole segment the marker starts, `phpmyadmin.svg` or `wp-login.php`.
            const end = bare.indexOf("/", at + 1);
            const segment = bare.slice(at, end < 0 ? undefined : end);
            if (!isStaticAssetPath(segment)) return true;
        }
        from = at + 1;
    }
}
