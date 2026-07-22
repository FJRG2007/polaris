/**
 * Update checker. Compares the commit the running image was built from against
 * the head of the release branch on GitHub, so the dashboard can tell an
 * operator when a newer build is available. The GitHub call is cached in-process
 * for a few hours (update cadence is slow and the endpoint is rate-limited when
 * unauthenticated), with a manual force path for the settings page. A single
 * in-flight request is shared so concurrent callers never fan out to GitHub.
 */

import { loadEnv } from "@polaris/config";

export interface UpdateStatus {
    /** Short SHA the running build was made from, or null when unknown (dev). */
    readonly current: string | null;
    /** Short SHA at the head of the release branch, or null when unreachable. */
    readonly latest: string | null;
    /** Commits the running build is behind the branch head, or null if unknown. */
    readonly behindBy: number | null;
    /** True only when we can confirm the build matches the branch head. */
    readonly upToDate: boolean;
    /** GitHub URL to view the difference (or the branch history). */
    readonly url: string;
    /** When this status was last fetched from GitHub (ISO 8601). */
    readonly checkedAt: string;
    /** Present when the last check failed; the rest is best-effort/stale. */
    readonly error?: string;
}

/** Update checks are cheap to be stale on; refresh at most every six hours. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Paths whose change rebuilds the web image (mirrors dashboard-publish.yml's `web`
 *  path filter). A change to the publish workflow itself rebuilds every image. Used
 *  to tell a real web update from a commit that only touches the daemon or docs. */
const WEB_IMAGE_PATHS =
    /^dashboard\/(apps|packages|cli)\/|^dashboard\/docker\/(Dockerfile|entrypoint\.sh)|^dashboard\/package(-lock)?\.json$|^\.github\/workflows\/dashboard-publish\.yml$/;

let cache: { status: UpdateStatus; at: number } | null = null;
let inflight: Promise<UpdateStatus> | null = null;

function short(sha: string): string {
    return sha.slice(0, 7);
}

async function github(path: string): Promise<unknown> {
    const response = await fetch(`https://api.github.com${path}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "polaris-dashboard" },
        // Never let a slow API call hang a page render or the poll endpoint.
        signal: AbortSignal.timeout(6000)
    });
    if (response.status === 403 || response.status === 429) {
        throw new Error("GitHub rate limit reached; try again later");
    }
    if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
    return response.json();
}

async function query(): Promise<UpdateStatus> {
    const env = loadEnv();
    const repo = env.POLARIS_REPO;
    const branch = env.POLARIS_UPDATE_BRANCH;
    const build = env.POLARIS_BUILD_SHA.trim();
    const checkedAt = new Date().toISOString();

    // With a known build commit, a compare gives both the branch head and the
    // exact number of commits we are behind it.
    if (build) {
        const data = (await github(`/repos/${repo}/compare/${build}...${branch}`)) as {
            status?: string;
            ahead_by?: number;
            permalink_url?: string;
            html_url?: string;
            files?: { filename?: string }[];
        };
        const aheadBy = typeof data.ahead_by === "number" ? data.ahead_by : null;
        // The running build is the published web image; the update pulls that image.
        // A commit that changes only non-web sources (the Rust daemon, docs) advances
        // the branch head but never rebuilds the web image, so its build SHA would sit
        // "behind" forever and no update could clear it. Only treat the branch as ahead
        // when a changed file would actually rebuild the web image - mirroring the
        // dashboard-publish workflow's `web` path filter.
        const webChanged = (data.files ?? []).some((file) => file.filename && WEB_IMAGE_PATHS.test(file.filename));
        const behindBy = aheadBy === null ? null : webChanged ? aheadBy : 0;
        return {
            current: short(build),
            latest: null === behindBy ? null : behindBy === 0 ? short(build) : null,
            behindBy,
            upToDate: data.status === "identical" || behindBy === 0,
            url: data.html_url ?? data.permalink_url ?? `https://github.com/${repo}/commits/${branch}`,
            checkedAt
        };
    }

    // No build commit (dev/source run): we can still report the latest head, but
    // cannot know whether the running code matches it.
    const head = (await github(`/repos/${repo}/commits/${branch}`)) as {
        sha?: string;
        html_url?: string;
    };
    return {
        current: null,
        latest: head.sha ? short(head.sha) : null,
        behindBy: null,
        upToDate: false,
        url: head.html_url ?? `https://github.com/${repo}/commits/${branch}`,
        checkedAt
    };
}

/**
 * Current update status. Serves the cached result within the TTL; `force`
 * bypasses the cache (the settings "Check now" button). On a failed fetch it
 * keeps and returns the last good status, annotated with the error, rather than
 * throwing - a missing update check must never break a page.
 */
export async function getUpdateStatus(force = false): Promise<UpdateStatus> {
    const now = Date.now();
    if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.status;
    if (inflight) return inflight;

    inflight = query()
        .then((status) => {
            cache = { status, at: Date.now() };
            return status;
        })
        .catch((caught): UpdateStatus => {
            const env = loadEnv();
            const message = caught instanceof Error ? caught.message : "Update check failed";
            const base: UpdateStatus = cache?.status ?? {
                current: env.POLARIS_BUILD_SHA ? short(env.POLARIS_BUILD_SHA) : null,
                latest: null,
                behindBy: null,
                upToDate: false,
                url: `https://github.com/${env.POLARIS_REPO}/commits/${env.POLARIS_UPDATE_BRANCH}`,
                checkedAt: new Date().toISOString()
            };
            return { ...base, error: message };
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}
