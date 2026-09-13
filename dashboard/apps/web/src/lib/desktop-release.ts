/**
 * Whether the Polaris desktop app can actually be downloaded, and from where.
 *
 * `.github/workflows/desktop.yml` builds the installers and publishes a release
 * when somebody pushes a `desktop-v*` tag. Until somebody does, there is no such
 * release - and this module used to hand out a link to the releases page filtered
 * by that tag regardless, which is a page reading "No releases found" behind the
 * only button on the card. So the link is no longer derived from the repository's
 * name; it is derived from a release that exists.
 *
 * The answer is cached for ten minutes INCLUDING the answer "there is none".
 * Without that, every deployment in the world - all of which are in exactly that
 * state today - would ask GitHub once per view of the preferences page, against an
 * unauthenticated budget of sixty calls an hour that the update card already spends
 * from the same address.
 */

/** An "owner/name" GitHub accepts. Anything else - a typo in the environment -
 *  gets no link rather than a link to a page that is not there. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** How the app's releases are tagged, and what tells them from the dashboard's. */
const DESKTOP_TAG = /^desktop-v/;

/** Releases move at release speed; ten minutes is stale enough to be free. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** One release, in the fields this module reads. Everything is `unknown` because
 *  it arrives from the network and is checked here rather than trusted. */
export interface ReleaseListing {
    readonly tag_name?: unknown;
    readonly html_url?: unknown;
    readonly draft?: unknown;
    readonly published_at?: unknown;
}

export interface DesktopDownload {
    readonly url: string;
    /** The version as the tag spells it, so the button can name what it fetches. */
    readonly version: string;
}

function publishedAt(release: ReleaseListing): number {
    const published = release.published_at;
    if (typeof published !== "string") return 0;
    const moment = Date.parse(published);
    return Number.isFinite(moment) ? moment : 0;
}

/**
 * The newest published desktop release out of a list, or null.
 *
 * Pure, and tested, because every way of getting this wrong points somewhere real.
 * This repository releases the dashboard as well, under `dashboard-v*`, so the
 * newest release is usually not the app. A draft is visible only to people who can
 * edit the repository, so offering one sends everybody else to a 404. And the order
 * the API answers in is not a promise, so the newest is chosen by when it was
 * published rather than by position.
 */
export function pickDesktopRelease(releases: readonly ReleaseListing[]): DesktopDownload | null {
    const usable = releases.filter(
        (release) =>
            typeof release.tag_name === "string" &&
            DESKTOP_TAG.test(release.tag_name) &&
            release.draft !== true &&
            typeof release.html_url === "string" &&
            release.html_url !== ""
    );
    const newest = [...usable].sort((a, b) => publishedAt(b) - publishedAt(a))[0];
    if (!newest) return null;
    return {
        url: newest.html_url as string,
        version: (newest.tag_name as string).replace(DESKTOP_TAG, "")
    };
}

let cache: { repo: string; found: DesktopDownload | null; at: number } | null = null;

async function ask(repo: string): Promise<DesktopDownload | null> {
    try {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
            headers: { accept: "application/vnd.github+json", "user-agent": "polaris-dashboard" },
            // Never let a slow API call hang a page render.
            signal: AbortSignal.timeout(6000)
        });
        if (!response.ok) return null;
        const body = (await response.json()) as unknown;
        return Array.isArray(body) ? pickDesktopRelease(body as ReleaseListing[]) : null;
    } catch {
        // A preferences page must not fail because GitHub is unreachable. No answer
        // reads as "not published", which understates at worst: the card then points
        // at installing Polaris, which works without GitHub at all.
        return null;
    }
}

/**
 * The desktop app download for this deployment's repository, or null when there
 * is none to offer.
 *
 * A failure is cached the same as a genuine absence. Distinguishing them would buy
 * a fresher answer during a GitHub outage, for a button that is disabled either way.
 */
export async function desktopDownload(repo: string): Promise<DesktopDownload | null> {
    const trimmed = repo.trim();
    if (!REPO.test(trimmed)) return null;

    const now = Date.now();
    if (cache && cache.repo === trimmed && now - cache.at < CACHE_TTL_MS) return cache.found;

    const found = await ask(trimmed);
    cache = { repo: trimmed, found, at: Date.now() };
    return found;
}
