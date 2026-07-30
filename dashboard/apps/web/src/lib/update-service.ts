/**
 * Update checker.
 *
 * An update is a new IMAGE to pull, not a new commit. CI builds and publishes the
 * dashboard image minutes after a commit lands, so a checker that compares the
 * running build against the branch head offers an update that cannot be installed
 * yet: the pull would fetch the same image it is already running, the update would
 * be a no-op, and the card would keep offering it. So the registry is the source of
 * truth here - the commit baked into the published image is what a deployment can
 * actually move to - and the branch head only distinguishes "nothing new" from
 * "something new is still being built", which is a fact worth showing and not one
 * to act on.
 *
 * GitHub is best-effort throughout: the registry alone decides whether an update
 * exists, so a rate-limited or unreachable API costs the commit count and the
 * building hint, never the answer.
 *
 * The result is cached in-process (many tabs, one check) with a manual force path
 * for the settings button, and a single in-flight request is shared so concurrent
 * callers never fan out.
 */

import { loadEnv } from "@polaris/config";
import { readPublishedImage } from "./registry";

/** Where a deployment stands relative to what has been published. */
export type UpdatePhase =
    /** Running exactly what the registry serves, with nothing newer on the branch. */
    | "up-to-date"
    /** A newer image is published and can be installed now. */
    | "available"
    /** The branch moved ahead of the published image; CI has not published it yet. */
    | "building"
    /** Not comparable - a source/dev run, or the check could not be completed. */
    | "unknown";

export interface UpdateStatus {
    readonly phase: UpdatePhase;
    /** Short SHA the running build was made from, or null when unknown (dev). */
    readonly current: string | null;
    /** Short SHA of the commit the PUBLISHED image was built from. */
    readonly latest: string | null;
    /** Commits between the running build and the published image, when countable. */
    readonly behindBy: number | null;
    /** True only when we can confirm the deployment runs the published image. */
    readonly upToDate: boolean;
    /** Commits waiting on a build, in the `building` phase. */
    readonly buildingCount: number | null;
    /** When the published image was built (ISO 8601), when the registry records it. */
    readonly publishedAt: string | null;
    /** GitHub URL to view the difference (or the branch history). */
    readonly url: string;
    /** When this status was last fetched (ISO 8601). */
    readonly checkedAt: string;
    /** Present when the last check failed; the rest is best-effort/stale. */
    readonly error?: string;
}

/** Registry reads are cheap and updates land at CI speed; ten minutes is stale
 *  enough to be free and fresh enough that the card is right after a release. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Paths whose change rebuilds the web image (mirrors dashboard-publish.yml's `web`
 *  path filter). Used only to tell "a build is pending" from "a commit landed that
 *  never produces a new image" - a daemon-only or docs commit is not an update. */
const WEB_IMAGE_PATHS =
    /^dashboard\/(apps|packages|cli|patches)\/|^dashboard\/docker\/(Dockerfile|entrypoint\.sh)|^dashboard\/package(-lock)?\.json$|^\.github\/workflows\/dashboard-publish\.yml$/;

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

interface Comparison {
    readonly status: string | null;
    readonly aheadBy: number | null;
    readonly url: string | null;
    readonly files: readonly string[];
}

/** `base...head` as GitHub sees it, or null when the API cannot be reached. */
async function compare(repo: string, base: string, head: string): Promise<Comparison | null> {
    try {
        const data = (await github(`/repos/${repo}/compare/${base}...${head}`)) as {
            status?: string;
            ahead_by?: number;
            html_url?: string;
            permalink_url?: string;
            files?: { filename?: string }[];
        };
        return {
            status: data.status ?? null,
            aheadBy: typeof data.ahead_by === "number" ? data.ahead_by : null,
            url: data.html_url ?? data.permalink_url ?? null,
            files: (data.files ?? []).map((file) => file.filename ?? "").filter((name) => name.length > 0)
        };
    } catch {
        // Best-effort: the registry has already answered the question that matters.
        return null;
    }
}

async function query(): Promise<UpdateStatus> {
    const env = loadEnv();
    const repo = env.POLARIS_REPO;
    const branch = env.POLARIS_UPDATE_BRANCH;
    const running = env.POLARIS_BUILD_SHA.trim();
    const checkedAt = new Date().toISOString();
    const branchUrl = `https://github.com/${repo}/commits/${branch}`;

    // What a pull would fetch right now. This is the only call that may fail the
    // check: without it there is no honest answer, only a guess.
    const published = await readPublishedImage(env.POLARIS_WEB_IMAGE, env.POLARIS_IMAGE_TAG);
    const target = published.buildSha;

    const base = {
        current: running ? short(running) : null,
        latest: target ? short(target) : null,
        publishedAt: published.createdAt,
        checkedAt
    };

    // A source or dev run carries no build stamp, and an image without one cannot
    // be placed either. Say so rather than implying a state.
    if (!running || !target) {
        return { ...base, phase: "unknown", behindBy: null, upToDate: false, buildingCount: null, url: branchUrl };
    }

    // Already running the published image: the only thing left to report is whether
    // the branch has moved past it, i.e. a build is on its way.
    if (running === target) {
        const pending = await compare(repo, target, branch);
        const rebuilds = pending?.files.some((file) => WEB_IMAGE_PATHS.test(file)) ?? false;
        const building = (pending?.aheadBy ?? 0) > 0 && rebuilds;
        return {
            ...base,
            phase: building ? "building" : "up-to-date",
            behindBy: 0,
            upToDate: !building,
            buildingCount: building ? pending?.aheadBy ?? null : null,
            url: building ? pending?.url ?? branchUrl : branchUrl
        };
    }

    // The published image is a different commit. Which way round matters: a
    // deployment that built its own image from a newer checkout is not behind.
    const moved = await compare(repo, running, target);
    if (moved && (moved.status === "behind" || moved.status === "identical")) {
        return { ...base, phase: "up-to-date", behindBy: 0, upToDate: true, buildingCount: null, url: branchUrl };
    }
    return {
        ...base,
        phase: "available",
        behindBy: moved?.aheadBy ?? null,
        upToDate: false,
        buildingCount: null,
        url: moved?.url ?? branchUrl
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
            const fallback: UpdateStatus = cache?.status ?? {
                phase: "unknown",
                current: env.POLARIS_BUILD_SHA ? short(env.POLARIS_BUILD_SHA) : null,
                latest: null,
                behindBy: null,
                upToDate: false,
                buildingCount: null,
                publishedAt: null,
                url: `https://github.com/${env.POLARIS_REPO}/commits/${env.POLARIS_UPDATE_BRANCH}`,
                checkedAt: new Date().toISOString()
            };
            return { ...fallback, error: message };
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}
