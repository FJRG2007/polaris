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
 * The list is cached for two minutes per repository INCLUDING "there is none", and
 * read once for every app. Without that, each view of a screen mentioning them spends
 * the sixty unauthenticated calls an hour that the update card already spends from
 * the same address. It used
 * to be ten, and ten is how long somebody looking for a release that had just been
 * published was shown the one before it - by a screen that has no refresh of its own.
 *
 * Past the two minutes the first page is asked for again with the `etag` it last
 * came with. An unchanged list answers `304` with no body, and the answer already
 * held is kept without walking the pages again; GitHub only promises that a `304`
 * is free of the rate limit for an authorized caller, so the two minutes are what
 * bounds the spending, and the `etag` is what keeps each look cheap.
 */

/** An "owner/name" GitHub accepts. Anything else - a typo in the environment -
 *  gets no link rather than a link to a page that is not there. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Short enough that a release just published is on screen before anybody wonders
 *  where it is, long enough that a busy screen costs a few calls an hour. */
const CACHE_TTL_MS = 2 * 60 * 1000;

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
export const STREAMDECK_TAG_PREFIX = "streamdeck-v";
export const COMPANION_TAG_PREFIX = "companion-v";
export const TV_TAG_PREFIX = "tv-v";

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

/** Every prefix a screen asks about. One walk of the list answers all of them, so
 *  it stops once each has been seen rather than once the first one has. */
const KNOWN_PREFIXES = [
    DESKTOP_TAG_PREFIX,
    EXTENSION_TAG_PREFIX,
    STREAMDECK_TAG_PREFIX,
    COMPANION_TAG_PREFIX,
    TV_TAG_PREFIX
] as const;

/** How soon a lookup that failed is tried again. Short, because the failure is
 *  usually GitHub's hourly limit or a slow answer, and either passes. */
const RETRY_MS = 30 * 1000;

interface Held {
    /** The releases the last walk that finished saw, or null when none has. */
    readonly releases: readonly ReleaseListing[] | null;
    readonly at: number;
    /** The first page's `etag` when this list was read, if it had one. */
    readonly etag: string | null;
}

/** One app's release as a screen needs it: the download, and whether GitHub was
 *  reached at all. `reached: false` is "could not ask", which a screen says in
 *  those words instead of claiming nothing has been released. */
export interface AppLookup {
    readonly download: AppDownload | null;
    readonly reached: boolean;
}

const cache = new Map<string, Held>();
const pending = new Map<string, Promise<Held>>();

/** What a walk came back with: the releases seen, and the first page's `etag`. A
 *  `304` on that page is `unchanged`, meaning the list already held still stands,
 *  and `failed` is a walk that did not finish. */
type Asked =
    | { readonly unchanged: true }
    | { readonly failed: true }
    | { readonly releases: readonly ReleaseListing[]; readonly etag: string | null };

function everyPrefixSeen(releases: readonly ReleaseListing[]): boolean {
    return KNOWN_PREFIXES.every((prefix) => pickRelease(releases, prefix) !== null);
}

async function ask(repo: string, etag: string | null): Promise<Asked> {
    const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    const seen: ReleaseListing[] = [];
    let first: string | null = null;
    try {
        for (let page = 1; page <= MAX_PAGES; page++) {
            const headers: Record<string, string> = {
                accept: "application/vnd.github+json",
                "user-agent": "polaris-dashboard"
            };
            if (page === 1 && etag) headers["if-none-match"] = etag;
            const response = await fetch(
                `https://api.github.com/repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`,
                // Never let a slow API call hang a page render.
                { headers, signal: deadline }
            );
            if (page === 1 && response.status === 304) return { unchanged: true };
            // A refusal - GitHub's hourly limit for an unauthenticated caller is
            // the usual one - is not an answer about what has been released.
            if (!response.ok) return { failed: true };
            if (page === 1) first = response.headers?.get("etag") ?? null;
            const body = (await response.json()) as unknown;
            if (!Array.isArray(body)) return { failed: true };
            seen.push(...(body as ReleaseListing[]));
            if (everyPrefixSeen(seen)) break;
            // A page GitHub did not fill is the last page there is.
            if (body.length < PAGE_SIZE) break;
        }
        return { releases: seen, etag: first };
    } catch {
        // Unreachable, or too slow: the page draws without the files rather than
        // failing, and says why.
        return { failed: true };
    }
}

/**
 * The newest release of one app for this deployment's repository, and whether
 * GitHub could be asked.
 *
 * The list is cached per repository, so one call answers every app a page shows.
 * Five apps used to be five calls a look, which is how a busy page spent the sixty
 * an hour GitHub allows, and every failure was cached for two minutes as "there is
 * none" - so whoever looked next was told the desktop app was not available yet
 * while version after version sat on the release page. A failed look now keeps the
 * last list that worked and tries again in thirty seconds; only with no list ever
 * read does a screen hear `reached: false`.
 */
export async function appLookup(repo: string, prefix: string): Promise<AppLookup> {
    const trimmed = repo.trim();
    if (!REPO.test(trimmed)) return { download: null, reached: true };
    const held = await heldList(trimmed);
    if (!held.releases) return { download: null, reached: false };
    return { download: pickRelease(held.releases, prefix), reached: true };
}

/** The newest release of one app, or null - not released, or not reachable. */
export async function appDownload(repo: string, prefix: string): Promise<AppDownload | null> {
    return (await appLookup(repo, prefix)).download;
}

async function heldList(repo: string): Promise<Held> {
    const held = cache.get(repo);
    if (held && Date.now() - held.at < CACHE_TTL_MS) return held;

    const running = pending.get(repo);
    if (running) return running;
    const lookup = refresh(repo, held).finally(() => pending.delete(repo));
    pending.set(repo, lookup);
    return lookup;
}

async function refresh(repo: string, held: Held | undefined): Promise<Held> {
    const asked = await ask(repo, held?.releases ? held.etag : null);
    const now = Date.now();
    let next: Held;
    if ("unchanged" in asked && held?.releases) {
        next = { ...held, at: now };
    } else if ("releases" in asked) {
        next = { releases: asked.releases, etag: asked.etag, at: now };
    } else {
        // Failed, or a 304 with no list held to keep: keep whatever list was last
        // read, and look again sooner than the usual two minutes.
        next = {
            releases: held?.releases ?? null,
            etag: held?.releases ? held.etag : null,
            at: now - CACHE_TTL_MS + RETRY_MS
        };
    }
    cache.set(repo, next);
    return next;
}

/** The desktop app for Windows, macOS and Linux. */
export async function desktopDownload(repo: string): Promise<AppDownload | null> {
    return appDownload(repo, DESKTOP_TAG_PREFIX);
}

/** The browser extension, as the packages `wxt zip` writes. */
export async function extensionDownload(repo: string): Promise<AppDownload | null> {
    return appDownload(repo, EXTENSION_TAG_PREFIX);
}

/** The Stream Deck plugin, as the one `.streamDeckPlugin` installer. */
export async function streamDeckDownload(repo: string): Promise<AppDownload | null> {
    return appDownload(repo, STREAMDECK_TAG_PREFIX);
}

/** The Bitfocus Companion module, as the one `.tgz` package Companion imports. */
export async function companionDownload(repo: string): Promise<AppDownload | null> {
    return appDownload(repo, COMPANION_TAG_PREFIX);
}

/** Polaris TV, as the APK the desktop app sideloads onto a set. */
export async function tvDownload(repo: string): Promise<AppDownload | null> {
    return appDownload(repo, TV_TAG_PREFIX);
}

/**
 * Whether a TV release carries what the desktop app installs from: the APK and
 * the checksum list it verifies it against (`desktop/src/main/tv-install.ts`).
 * A release without both is one the install refuses, so it is not offered.
 */
export function tvInstallable(release: AppDownload | null): boolean {
    if (!release) return false;
    const names = new Set(release.files.map((file) => file.name));
    return names.has("polaris-tv.apk") && names.has("SHA256SUMS");
}
