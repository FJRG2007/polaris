/**
 * Which of Polaris's own apps can actually be downloaded, and from where.
 *
 * Two things in this repository ship to somewhere other than a deployment's image:
 * the desktop app, released on `desktop-v*` tags, and the browser extension, on
 * `extension-v*`. Both are published as GitHub releases of the repository this
 * deployment updates from, and both used to be - or would have been - linked from a
 * URL built out of the repository's name, whether or not anything was there. That is
 * a button leading to a page reading "No releases found".
 *
 * So a link is derived from a release that exists. One module for both, because the
 * second consumer is where a shared GitHub call with its own cache stops being worth
 * writing twice.
 *
 * The answer is cached for ten minutes per app INCLUDING "there is none" - which is
 * the state every deployment is in for both apps today. Without that, each view of a
 * screen mentioning them spends one of the sixty unauthenticated calls an hour that
 * the update card already spends from the same address.
 */

/** An "owner/name" GitHub accepts. Anything else - a typo in the environment -
 *  gets no link rather than a link to a page that is not there. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Releases move at release speed; ten minutes is stale enough to be free. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** GitHub's largest page, and how far back to walk. One list holds every kind of
 *  release this repository cuts, so an app's newest sits behind however many others
 *  were published after it. A single page of thirty put the desktop app out of reach
 *  after thirty dashboard releases, and out of reach reads on screen as "not released
 *  yet" - the exact button this module exists to stop drawing. */
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

/** The whole walk rather than each page of it: a screen waits on this, and three
 *  timeouts in sequence would be three times as long as any one of them. */
const LOOKUP_TIMEOUT_MS = 6000;

/** How each app's releases are tagged, which is what tells them apart - this
 *  repository releases the dashboard as `dashboard-v*` as well. */
export const DESKTOP_TAG_PREFIX = "desktop-v";
export const EXTENSION_TAG_PREFIX = "extension-v";

/** One release, in the fields this module reads. Everything is `unknown` because
 *  it arrives from the network and is checked here rather than trusted. */
export interface ReleaseListing {
    readonly tag_name?: unknown;
    readonly html_url?: unknown;
    readonly draft?: unknown;
    readonly prerelease?: unknown;
    readonly published_at?: unknown;
    /** The files attached to it. Carried in the same answer as the release, so
     *  reading them costs no second call and no second cache. */
    readonly assets?: unknown;
}

/** One attached file, in the two fields a download needs. */
export interface ReleaseAsset {
    readonly name?: unknown;
    readonly browser_download_url?: unknown;
}

/** One file somebody can actually download. */
export interface AppFile {
    readonly name: string;
    readonly url: string;
}

export interface AppDownload {
    readonly url: string;
    /** The version as the tag spells it, so a button can name what it fetches. */
    readonly version: string;
    /**
     * The files on it, in the order the API listed them.
     *
     * Here so a screen can offer the installer for the machine somebody is on
     * instead of sending everybody to a release page to read a list of seven
     * files and work out which one is theirs. Empty is the ordinary case for a
     * release that attached nothing, and a screen with nothing to match falls
     * back to the release itself.
     */
    readonly files: readonly AppFile[];
}

/** The attached files of one release, keeping only entries that carry both a name
 *  and somewhere to fetch them from. */
function filesOf(release: ReleaseListing): readonly AppFile[] {
    if (!Array.isArray(release.assets)) return [];
    const files: AppFile[] = [];
    for (const asset of release.assets as readonly ReleaseAsset[]) {
        const name = asset?.name;
        const url = asset?.browser_download_url;
        if (typeof name !== "string" || name === "") continue;
        if (typeof url !== "string" || url === "") continue;
        files.push({ name, url });
    }
    return files;
}

/**
 * The one file matching every term, and none of the terms to avoid.
 *
 * Matched on the name rather than on a filename this module spells out, because
 * the names are its packagers': electron-forge decides what a `.dmg` for one
 * architecture is called, and WXT decides what a browser's package is called. A
 * screen asks for what it means - a `.dmg` for `arm64`, a `.zip` for `firefox`
 * that is not the `sources` one - and gets nothing if this release has no such
 * file, which is a row that says so rather than a link to a 404.
 */
export function pickFile(
    files: readonly AppFile[],
    has: readonly string[],
    not: readonly string[] = []
): AppFile | null {
    const wanted = has.map((term) => term.toLowerCase());
    const unwanted = not.map((term) => term.toLowerCase());
    for (const file of files) {
        const name = file.name.toLowerCase();
        if (!wanted.every((term) => name.includes(term))) continue;
        if (unwanted.some((term) => name.includes(term))) continue;
        return file;
    }
    return null;
}

function publishedAt(release: ReleaseListing): number {
    const published = release.published_at;
    if (typeof published !== "string") return 0;
    const moment = Date.parse(published);
    return Number.isFinite(moment) ? moment : 0;
}

/**
 * The newest published release carrying a tag prefix, or null.
 *
 * Pure, and tested, because every way of getting this wrong points somewhere real.
 * The repository releases more than one thing, so the newest release is usually not
 * the one being asked for. A draft is visible only to people who can edit the
 * repository, so offering one sends everybody else to a 404. A prerelease is a build
 * somebody marked as not ready, and this is the only download a deployment offers, so
 * an `rc` tag would reach everybody as though it were the release. And the order the
 * API answers in is not a promise, so the newest is chosen by publication date.
 */
export function pickRelease(
    releases: readonly ReleaseListing[],
    prefix: string
): AppDownload | null {
    const usable = releases.filter(
        (release) =>
            typeof release.tag_name === "string" &&
            release.tag_name.startsWith(prefix) &&
            release.draft !== true &&
            release.prerelease !== true &&
            typeof release.html_url === "string" &&
            release.html_url !== ""
    );
    const newest = [...usable].sort((a, b) => publishedAt(b) - publishedAt(a))[0];
    if (!newest) return null;
    return {
        url: newest.html_url as string,
        version: (newest.tag_name as string).slice(prefix.length),
        files: filesOf(newest)
    };
}

const cache = new Map<string, { found: AppDownload | null; at: number }>();

async function ask(repo: string, prefix: string): Promise<AppDownload | null> {
    const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    const seen: ReleaseListing[] = [];
    try {
        for (let page = 1; page <= MAX_PAGES; page++) {
            const response = await fetch(
                `https://api.github.com/repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`,
                {
                    headers: {
                        accept: "application/vnd.github+json",
                        "user-agent": "polaris-dashboard"
                    },
                    // Never let a slow API call hang a page render.
                    signal: deadline
                }
            );
            if (!response.ok) break;
            const body = (await response.json()) as unknown;
            if (!Array.isArray(body) || body.length === 0) break;
            seen.push(...(body as ReleaseListing[]));
            const found = pickRelease(seen, prefix);
            if (found) return found;
            // A page GitHub did not fill is the last page there is.
            if (body.length < PAGE_SIZE) break;
        }
        return null;
    } catch {
        // A page must not fail because GitHub is unreachable. No answer reads as
        // "not published", which understates at worst: the screen then points at
        // whatever works without GitHub at all.
        return null;
    }
}

/**
 * The newest release of one app for this deployment's repository, or null.
 *
 * A failure is cached the same as a genuine absence. Distinguishing them would buy
 * a fresher answer during a GitHub outage, for a button that is disabled either way.
 */
export async function appDownload(repo: string, prefix: string): Promise<AppDownload | null> {
    const trimmed = repo.trim();
    if (!REPO.test(trimmed)) return null;

    // "|" rather than a control character: the repository has already matched REPO,
    // which admits no "|", and the prefixes are constants - so a visible separator
    // separates exactly as well and leaves this file readable in a diff.
    const key = `${trimmed}|${prefix}`;
    const now = Date.now();
    const held = cache.get(key);
    if (held && now - held.at < CACHE_TTL_MS) return held.found;

    const found = await ask(trimmed, prefix);
    cache.set(key, { found, at: Date.now() });
    return found;
}

/** The desktop app for Windows, macOS and Linux. */
export async function desktopDownload(repo: string): Promise<AppDownload | null> {
    return appDownload(repo, DESKTOP_TAG_PREFIX);
}

/** The browser extension, as the packages `wxt zip` writes. */
export async function extensionDownload(repo: string): Promise<AppDownload | null> {
    return appDownload(repo, EXTENSION_TAG_PREFIX);
}
