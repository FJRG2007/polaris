/**
 * What an update carries, read from its commits, and whether it fixes a
 * vulnerability serious enough to install on its own.
 *
 * The range is the running build to the one on offer, asked of GitHub once:
 * a range of commits never changes, so the answer is kept for as long as the
 * pair is the one being offered. Severity comes from two places, the worst of
 * which wins - the `Security:` trailer a fix carries in its message
 * (`@polaris/core` changelog), and the write-ups in docs/vulnerabilities that
 * the range marks fixed, which is where older fixes recorded theirs.
 *
 * Bounded: at hundreds of commits a day a deployment a week behind is
 * thousands of commits, so at most `MAX_PAGES` pages are read and the rest is
 * counted, not listed. The severity is never bounded that way silently: when
 * the range is longer than what was read, the write-ups changed in it still
 * decide (GitHub lists a comparison's files whatever its length, up to 300).
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { github } from "@/lib/update-service";
import { getSetting, setSetting } from "@/lib/setting-store";

/** 100 commits a page; five is a fortnight of a busy main. */
const PER_PAGE = 100;
const MAX_PAGES = 5;
/** What the settings screen lists; the rest is a count and a link. */
const MAX_LISTED = 300;
const WRITE_UP = /^docs\/vulnerabilities\/VULN-\d+[^/]*\.md$/;

export interface UpdateChangelog {
    readonly base: string;
    readonly head: string;
    readonly entries: readonly core.ChangelogEntry[];
    /** Entries left off the list, past `MAX_LISTED` or past the pages read. */
    readonly more: number;
    /** Commits left out because nobody running Polaris would notice them. */
    readonly hidden: number;
    readonly security: core.SecuritySeverity | null;
    /** The vulnerability write-ups this range marks fixed, by id. */
    readonly fixes: readonly { readonly id: string; readonly severity: core.SecuritySeverity }[];
    readonly url: string;
}

let kept: UpdateChangelog | null = null;
let inflight: { key: string; promise: Promise<UpdateChangelog | null> } | null = null;

interface ComparePage {
    total_commits?: number;
    html_url?: string;
    commits?: { sha?: string; commit?: { message?: string } }[];
    files?: { filename?: string; status?: string }[];
}

/** The severity a write-up records, read at the commit on offer. */
async function writeUpSeverity(repo: string, head: string, path: string) {
    try {
        const response = await fetch(`https://raw.githubusercontent.com/${repo}/${head}/${path}`, {
            headers: { "user-agent": "polaris-dashboard" },
            signal: AbortSignal.timeout(6000)
        });
        if (!response.ok) return null;
        return core.fixedSeverityFromWriteUp(await response.text());
    } catch {
        return null;
    }
}

async function read(repo: string, base: string, head: string): Promise<UpdateChangelog | null> {
    const commits: { sha: string; message: string }[] = [];
    let total = 0;
    let url = `https://github.com/${repo}/compare/${base}...${head}`;
    let files: { filename?: string; status?: string }[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        let data: ComparePage;
        try {
            data = (await github(
                `/repos/${repo}/compare/${base}...${head}?per_page=${PER_PAGE}&page=${page}`
            )) as ComparePage;
        } catch {
            // Nothing read at all is no answer; a later page failing is a shorter list.
            if (page === 1) return null;
            break;
        }
        if (page === 1) {
            total = data.total_commits ?? 0;
            url = data.html_url ?? url;
            files = data.files ?? [];
        }
        const batch = data.commits ?? [];
        for (const commit of batch) {
            if (commit.sha) commits.push({ sha: commit.sha, message: commit.commit?.message ?? "" });
        }
        if (batch.length < PER_PAGE || commits.length >= total) break;
    }
    // GitHub lists a comparison oldest first; a changelog reads newest first.
    const changelog = core.buildChangelog([...commits].reverse());

    const writeUps = files
        .map((file) => file.filename ?? "")
        .filter((name) => WRITE_UP.test(name))
        .slice(0, 50);
    const fixes = (
        await Promise.all(
            writeUps.map(async (path) => {
                const severity = await writeUpSeverity(repo, head, path);
                const id = /VULN-\d+/.exec(path)?.[0] ?? path;
                return severity ? { id, severity } : null;
            })
        )
    ).filter((fix): fix is { id: string; severity: core.SecuritySeverity } => fix !== null);

    const security = fixes.reduce<core.SecuritySeverity | null>(
        (worst, fix) => core.worstSeverity(worst, fix.severity),
        changelog.security
    );
    const unread = Math.max(0, total - commits.length);
    return {
        base,
        head,
        entries: changelog.entries.slice(0, MAX_LISTED),
        more: Math.max(0, changelog.entries.length - MAX_LISTED) + unread,
        hidden: changelog.hidden,
        security,
        fixes,
        url
    };
}

/**
 * The changelog from the running build to `head`, or null when either end is
 * unknown or GitHub cannot be reached. Asked once per pair.
 */
export async function updateChangelog(
    base: string | null,
    head: string | null
): Promise<UpdateChangelog | null> {
    if (!base || !head || base === head) return null;
    if (kept && kept.base === base && kept.head === head) return kept;
    const key = `${base}...${head}`;
    if (inflight?.key === key) return inflight.promise;
    const promise = read(loadEnv().POLARIS_REPO, base, head)
        .then((result) => {
            if (result) kept = result;
            return result;
        })
        .finally(() => {
            if (inflight?.key === key) inflight = null;
        });
    inflight = { key, promise };
    return promise;
}

// ---------------------------------------------------------------------------
// The quietest hour
// ---------------------------------------------------------------------------

const QUIET_KEY = "updates.quietHour";
const QUIET_TTL_MS = 24 * 60 * 60_000;
const QUIET_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** Enough to say something about a deployment's day; fewer reads as no pattern. */
const QUIET_MIN_EVENTS = 50;
const QUIET_SAMPLE = 20_000;
/** When there is no pattern yet: the small hours, when most deployments idle. */
export const DEFAULT_QUIET_HOUR = 4;

/**
 * The hour of the day (0-23, server time) this deployment is least used, from
 * its own record over the last two weeks: what people did (the audit log) and
 * when they signed in. Worked out once a day and kept; a deployment with too
 * little history answers `DEFAULT_QUIET_HOUR`.
 */
export async function quietHour(now = new Date()): Promise<number> {
    try {
        const raw = await getSetting(QUIET_KEY);
        if (raw) {
            const stored = JSON.parse(raw) as { hour?: unknown; at?: unknown };
            if (
                typeof stored.hour === "number" &&
                typeof stored.at === "number" &&
                now.getTime() - stored.at < QUIET_TTL_MS
            ) {
                return stored.hour;
            }
        }
    } catch {
        // Unreadable: worked out again below.
    }
    const since = new Date(now.getTime() - QUIET_WINDOW_MS);
    const [audit, sessions] = await Promise.all([
        prisma.auditLog.findMany({
            where: { at: { gte: since } },
            select: { at: true },
            orderBy: { at: "desc" },
            take: QUIET_SAMPLE
        }),
        prisma.session.findMany({
            where: { createdAt: { gte: since } },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: QUIET_SAMPLE
        })
    ]);
    const hour = quietestHour([
        ...audit.map((row) => row.at),
        ...sessions.map((row) => row.createdAt)
    ]);
    await setSetting(QUIET_KEY, JSON.stringify({ hour, at: now.getTime() })).catch(() => undefined);
    return hour;
}

/**
 * The hour with the least activity in these moments, the earliest of a tie, or
 * `DEFAULT_QUIET_HOUR` when there are too few to tell.
 */
export function quietestHour(moments: readonly Date[]): number {
    if (moments.length < QUIET_MIN_EVENTS) return DEFAULT_QUIET_HOUR;
    const counts = new Array<number>(24).fill(0);
    for (const moment of moments) counts[moment.getHours()]! += 1;
    let best = 0;
    for (let hour = 1; hour < 24; hour += 1) if (counts[hour]! < counts[best]!) best = hour;
    return best;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

const SECURITY_POLICY_KEY = "updates.security";

/** How this deployment installs an update that fixes a vulnerability. */
export async function getSecurityUpdatePolicy(): Promise<core.SecurityUpdatePolicy> {
    return core.parseSecurityUpdatePolicy(await getSetting(SECURITY_POLICY_KEY));
}

export async function saveSecurityUpdatePolicy(policy: core.SecurityUpdatePolicy): Promise<void> {
    await setSetting(SECURITY_POLICY_KEY, JSON.stringify(policy));
}
