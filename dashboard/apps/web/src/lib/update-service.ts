/**
 * Update checker.
 *
 * What counts as an update depends on where this deployment takes its updates
 * from (see update-source). On the default - the image CI publishes - an update
 * is a new IMAGE to pull, and everything below applies. On a deployment that
 * builds on the host, the checkout is the update: a newer commit can be
 * installed the moment it lands, so the branch head is the target and the
 * registry has no say.
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
 * What CI made of a commit is the other half of the answer. Publishing is gated on
 * the suites passing, but a tag can still carry an image from a commit that failed
 * them - a manual run, or an image published before the gate existed - and
 * installing that is how a red build reaches a box that was only told an update
 * exists. So a failed commit is reported as such instead of being offered, and a
 * branch waiting on a build that will never come is not called "building".
 *
 * Only the suites behind the image being offered count, though. One commit builds
 * several images from one repository, and judging the dashboard by a host-daemon
 * failure blocks an install that failure has no bearing on - permanently, because
 * the commits that fix it rebuild no dashboard image, so the tag never moves off
 * the commit that is being held against it.
 *
 * GitHub is best-effort throughout: the registry alone decides whether an update
 * exists, so a rate-limited or unreachable API costs the commit count, the
 * building hint and the CI verdict, never the answer.
 *
 * The result is cached in-process (many tabs, one check) with a manual force path
 * for the settings button, and a single in-flight request is shared so concurrent
 * callers never fan out.
 */

import { loadEnv } from "@polaris/config";
import { readPublishedImage } from "./registry";
import { getUpdateSource } from "./update-source";
import { DEFAULT_UPDATE_SOURCE, type UpdateSource } from "@polaris/core";

/** Where a deployment stands relative to what has been published. */
export type UpdatePhase =
    /** Running exactly what the registry serves, with nothing newer on the branch. */
    | "up-to-date"
    /** A newer image is published and can be installed now. */
    | "available"
    /** The branch moved ahead of the published image; CI has not published it yet. */
    | "building"
    /** Something newer exists, but the commit behind it failed its checks. */
    | "blocked"
    /** Not comparable - a source/dev run, or the check could not be completed. */
    | "unknown";

/** How CI judged a commit. */
export type ChecksVerdict = "passed" | "failed" | "running";

export interface UpdateStatus {
    readonly phase: UpdatePhase;
    /** Where an update would come from, which is what `latest` describes. */
    readonly source: UpdateSource;
    /** Short SHA the running build was made from, or null when unknown (dev). */
    readonly current: string | null;
    /** Short SHA of the commit an update would install: the one the published
     *  image was built from, or the branch head when this host builds its own. */
    readonly latest: string | null;
    /** Commits between the running build and that commit, when countable. */
    readonly behindBy: number | null;
    /** True only when we can confirm the deployment runs the published image. */
    readonly upToDate: boolean;
    /** Commits waiting on a build, in the `building` phase. */
    readonly buildingCount: number | null;
    /** When the published image was built (ISO 8601), when the registry records it. */
    readonly publishedAt: string | null;
    /** How the commit an update would install fared in the suites that gate it,
     *  or null when GitHub could not say. */
    readonly checks: ChecksVerdict | null;
    /** The run to look at, when the checks failed. */
    readonly checksUrl: string | null;
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

/** Check runs that decide whether the dashboard image is safe to install
 *  (mirrors dashboard-publish.yml: `web` needs `changes` and `dashboard-ci`, the
 *  latter being dashboard-ci.yml's `build` job - named bare when it runs on the
 *  push and prefixed when the publish calls it). `rust-ci` gates the host daemon
 *  and every other image job gates its own image, so a failure there says nothing
 *  about this one; letting it veto pinned a deployment to a commit it could never
 *  move off, because the commits that fixed it rebuilt no dashboard image. */
const WEB_IMAGE_CHECKS = /^(changes|web|build|dashboard-ci \/ .+)$/;

let cache: { status: UpdateStatus; at: number; } | null = null;
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
            files?: { filename?: string; }[];
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

interface ChecksResult {
    readonly verdict: ChecksVerdict;
    /** The failing run, when one failed. */
    readonly url: string | null;
}

/**
 * What CI made of a commit (or of a branch's head), or null when GitHub cannot
 * say - no runs at all is also null, since "nobody checked" is not a verdict.
 *
 * Only a completed failure counts as failed: a run still going has not decided
 * yet, and a skipped job is one the push did not need - most of a publish is
 * skipped on any given commit, so treating that as anything but fine would call
 * every commit broken.
 *
 * `gates` narrows the answer to the suites that produce the artefact being
 * offered. Without it every run counts, which is what a host building the whole
 * checkout needs; with it, a suite covering a different artefact cannot veto
 * this one. Filtering everything out is the same as finding nothing: unjudged,
 * not failed.
 */
async function checksFor(repo: string, ref: string, gates?: RegExp): Promise<ChecksResult | null> {
    try {
        const data = (await github(`/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`)) as {
            check_runs?: {
                name?: string;
                status?: string;
                conclusion?: string | null;
                html_url?: string | null;
            }[];
        };
        const all = data.check_runs ?? [];
        const runs = gates ? all.filter((run) => gates.test(run.name ?? "")) : all;
        if (runs.length === 0) return null;
        const failed = runs.find((run) => run.conclusion === "failure" || run.conclusion === "timed_out");
        if (failed) return { verdict: "failed", url: failed.html_url ?? null };
        return { verdict: runs.some((run) => run.status !== "completed") ? "running" : "passed", url: null };
    } catch {
        // Best-effort: an unanswered check leaves the phase where it was.
        return null;
    }
}

/** The commit a branch points at, or null when GitHub cannot say. */
async function branchHead(repo: string, branch: string): Promise<string | null> {
    try {
        const data = (await github(`/repos/${repo}/commits/${encodeURIComponent(branch)}`)) as { sha?: string; };
        return data.sha ?? null;
    } catch {
        return null;
    }
}

/**
 * Where a deployment that builds its own image stands. The branch is the target,
 * so there is nothing to wait for: a commit that has landed can be installed,
 * and GitHub is the only source of truth - unreachable means unknown rather than
 * up to date, because claiming the latter without having looked is how a
 * deployment sits on an old build believing it is current.
 */
async function buildQuery(input: {
    repo: string;
    branch: string;
    running: string;
    checkedAt: string;
    branchUrl: string;
}): Promise<UpdateStatus> {
    const { repo, branch, running, checkedAt, branchUrl } = input;
    const head = await branchHead(repo, branch);
    const base = {
        source: "build" as const,
        current: running ? short(running) : null,
        latest: head ? short(head) : null,
        publishedAt: null,
        checks: null as ChecksVerdict | null,
        checksUrl: null as string | null,
        buildingCount: null,
        checkedAt
    };

    if (!running || !head) {
        return { ...base, phase: "unknown", behindBy: null, upToDate: false, url: branchUrl };
    }
    if (running === head) {
        return { ...base, phase: "up-to-date", behindBy: 0, upToDate: true, url: branchUrl };
    }

    // A host that built from a newer checkout than the branch is ahead, not behind.
    const moved = await compare(repo, running, head);
    if (moved && (moved.status === "behind" || moved.status === "identical")) {
        return { ...base, phase: "up-to-date", behindBy: 0, upToDate: true, url: branchUrl };
    }
    // The suites still gate what is offered: building a commit that failed them
    // on this host would only reproduce the failure locally.
    const checks = await checksFor(repo, head);
    return {
        ...base,
        phase: checks?.verdict === "failed" ? "blocked" : "available",
        behindBy: moved?.aheadBy ?? null,
        upToDate: false,
        checks: checks?.verdict ?? null,
        checksUrl: checks?.url ?? null,
        url: moved?.url ?? branchUrl
    };
}

async function query(): Promise<UpdateStatus> {
    const env = loadEnv();
    const repo = env.POLARIS_REPO;
    const branch = env.POLARIS_UPDATE_BRANCH;
    const running = env.POLARIS_BUILD_SHA.trim();
    const checkedAt = new Date().toISOString();
    const branchUrl = `https://github.com/${repo}/commits/${branch}`;

    if ((await getUpdateSource()) === "build") {
        return buildQuery({ repo, branch, running, checkedAt, branchUrl });
    }

    // What a pull would fetch right now. This is the only call that may fail the
    // check: without it there is no honest answer, only a guess.
    const published = await readPublishedImage(env.POLARIS_WEB_IMAGE, env.POLARIS_IMAGE_TAG);
    const target = published.buildSha;

    const base = {
        source: "image" as const,
        current: running ? short(running) : null,
        latest: target ? short(target) : null,
        publishedAt: published.createdAt,
        checks: null as ChecksVerdict | null,
        checksUrl: null as string | null,
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
        // A commit that failed its suites is not a build on its way: publishing
        // waits on them, so no image is coming and "still building" would be a
        // wait with nothing at the end of it.
        const checks = building ? await checksFor(repo, branch, WEB_IMAGE_CHECKS) : null;
        const blocked = checks?.verdict === "failed";
        return {
            ...base,
            phase: blocked ? "blocked" : building ? "building" : "up-to-date",
            behindBy: 0,
            upToDate: !building,
            buildingCount: building ? pending?.aheadBy ?? null : null,
            checks: checks?.verdict ?? null,
            checksUrl: checks?.url ?? null,
            url: building ? pending?.url ?? branchUrl : branchUrl
        };
    }

    // The published image is a different commit. Which way round matters: a
    // deployment that built its own image from a newer checkout is not behind.
    const moved = await compare(repo, running, target);
    if (moved && (moved.status === "behind" || moved.status === "identical")) {
        return { ...base, phase: "up-to-date", behindBy: 0, upToDate: true, buildingCount: null, url: branchUrl };
    }
    // There is something to install; whether it should be installed is the last
    // question, and only a verdict that came back failed answers it no.
    const checks = await checksFor(repo, target, WEB_IMAGE_CHECKS);
    return {
        ...base,
        phase: checks?.verdict === "failed" ? "blocked" : "available",
        behindBy: moved?.aheadBy ?? null,
        upToDate: false,
        buildingCount: null,
        checks: checks?.verdict ?? null,
        checksUrl: checks?.url ?? null,
        url: moved?.url ?? branchUrl
    };
}

/**
 * Forget the cached answer. Called when the update source changes: the cached
 * status describes what an update meant a moment ago, and after the switch that
 * is a different question with a different answer.
 */
export function resetUpdateStatus(): void {
    cache = null;
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
                source: DEFAULT_UPDATE_SOURCE,
                current: env.POLARIS_BUILD_SHA ? short(env.POLARIS_BUILD_SHA) : null,
                latest: null,
                behindBy: null,
                upToDate: false,
                buildingCount: null,
                publishedAt: null,
                checks: null,
                checksUrl: null,
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
