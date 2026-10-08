/**
 * What is waiting for an administrator, as a number.
 *
 * Chat and Mail both put a count on their entry in the switcher, so somebody
 * working in Deploy is told a message arrived. Management had nothing: a
 * reported message sat in a queue, an update sat published, and the only way to
 * learn of either was to go and open the screen. A queue nobody is queued to is
 * a page somebody has to remember, and people do not.
 *
 * Three things, and each is chosen for the same reason: it is work that stays
 * undone until a person does it.
 *
 * - **Reported messages and safety cases**, counted open. Not "unread": a report
 *   somebody has read and not settled is still a report. What the badge does
 *   once the queue has been looked at is the reader's choice - by default the
 *   visit clears it until something new arrives, see `badge-seen.ts`.
 * - **An update nothing will install on its own.** A deployment set to install
 *   at three in the morning has no work for anybody, so it is not counted; one
 *   with automatic updates off has a person in the loop by definition, and that
 *   person is the one this badge is for.
 *
 * - **A Google API switched off** in the Cloud project this Polaris signs in
 *   with. Nobody's Google calendar or tasks come through until the
 *   administrator turns it on, and the person who notices is not the one who
 *   can: so it is counted here, on Integrations, where it is switched on - and
 *   the Calendar's own screen only says to ask. Counted until it is on again,
 *   never cleared by a visit: it is a fault, not news.
 *
 * Deliberately cheap: two counts and a few settings reads, no network. The update
 * check itself is a registry call and belongs to the watcher that already makes
 * it on a loop - this reads what that left behind, which also means it survives
 * a container restart, where the in-memory status cache does not.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { getSetting } from "@/lib/setting-store";
import { getAutoUpdatePolicy } from "@/lib/update-watcher";
import { badgeMarks, DISMISSED_KEYS, markSeen, type BadgeScreen } from "@/lib/badge-seen";

/** The key the update watcher claims once per published build, holding the short
 *  sha it announced and when. Read here rather than re-derived: the two must not
 *  disagree about what "there is an update" means. */
const ANNOUNCED_KEY = "updates.announced";

export interface AdminWaiting {
    /** Reported messages nobody has settled. */
    readonly reports: number;
    /** Locked-down accounts and reported people nobody has settled. */
    readonly cases: number;
    /** A published build this deployment is not running and nothing will install
     *  by itself. */
    readonly update: boolean;
    /** Google APIs recorded as switched off for this Polaris. */
    readonly apis: number;
    /** The three as one number, which is what a badge has room for. */
    readonly total: number;
}

export const NOTHING_WAITING: AdminWaiting = {
    reports: 0,
    cases: 0,
    update: false,
    apis: 0,
    total: 0
};

/** How many of these stored API states say the API is switched off. Pure: the
 *  reads are the caller's. */
export function googleApisOff(raws: readonly (string | null | undefined)[]): number {
    return raws.filter((raw) => core.readProviderApiState(raw)?.state === "disabled").length;
}

/** The Google APIs switched off for this Polaris, as their states were stored by
 *  whichever learned first - the Calendar's sync or the Integrations probe. */
async function apisOff(): Promise<number> {
    const raws = await Promise.all(
        core.GOOGLE_APIS.map((api) => getSetting(core.googleApiStateKey(api.id)).catch(() => null))
    );
    return googleApisOff(raws);
}

/**
 * Whether a published build is sitting there waiting for somebody to press
 * Install.
 *
 * The announced sha against the running one, which is the durable form of the
 * question - after an update installs, the build it announced is the build this
 * process is, and the answer becomes no on its own with nothing to clear. The
 * announcement is short, the running sha is not, so it is a prefix rather than
 * an equality.
 *
 * A development container has no build sha and therefore never has an update,
 * which is the truth: there is nothing here to install.
 *
 * Pure, and separate from the reads that feed it, because every branch of it is
 * a decision about somebody's badge and none of them needs a database to check.
 */
export function updateIsWaiting(input: {
    /** The sha this container was built from, or null where there is none. */
    readonly running: string | null;
    /** The short sha the watcher last announced, or null before it has. */
    readonly announced: string | null;
    /** What the deployment does about updates by itself: off, immediate, daily. */
    readonly autoUpdate: string;
}): boolean {
    if (!input.running || !input.announced) return false;
    if (input.running.startsWith(input.announced)) return false;
    // Something else is going to install it. Nothing for a person to do, so
    // nothing on the badge - it would be a number that goes away in the night
    // and teaches whoever sees it to ignore the next one.
    return input.autoUpdate === "off";
}

/** The short sha the update watcher last announced, or null before it has. */
async function announcedBuild(): Promise<string | null> {
    return (await getSetting(ANNOUNCED_KEY))?.split(" ")[0] ?? null;
}

/** The build waiting for somebody to press Install, or null when none is. */
async function updateWaiting(): Promise<string | null> {
    const running = loadEnv().POLARIS_BUILD_SHA ?? null;
    if (!running) return null;
    const [announced, policy] = await Promise.all([announcedBuild(), getAutoUpdatePolicy()]);
    return updateIsWaiting({ running, announced, autoUpdate: policy.mode }) ? announced : null;
}

/** When a queue was last opened, or null for never or a mark nobody can read. */
function seenAt(mark: string | undefined): Date | null {
    if (!mark) return null;
    const at = new Date(mark);
    return Number.isNaN(at.getTime()) ? null : at;
}

/** The later of two moments, either of which may be missing. */
function laterOf(left: Date | null, right: Date | null): Date | null {
    if (!left) return right;
    if (!right) return left;
    return left > right ? left : right;
}

/**
 * Everything above, in one read, as one administrator's badge.
 *
 * With `userId`, what that account has already seen is left out: what opening
 * a screen showed it, when it lets a visit clear its badge - the build it was
 * shown on the Update screen, the reports and cases older than its last visit
 * to Safety - and what it marked seen from the app menu, whichever way that
 * switch is set. Reports and cases are marked apart there, so each has its own
 * moment, and the later of the two marks wins.
 *
 * Best-effort per part: a settings table that will not answer must not take the
 * whole badge - and a badge that is short by one is better than a management
 * screen that will not draw.
 */
export async function adminWaiting(userId?: string): Promise<AdminWaiting> {
    const marks = userId ? await badgeMarks(userId).catch(() => null) : null;
    const visit = seenAt(marks?.seen?.get("admin.safety"));
    const since = (key: string) => {
        const at = laterOf(visit, seenAt(marks?.dismissed.get(key)));
        return at ? { createdAt: { gt: at } } : {};
    };
    const [reports, cases, build, apis] = await Promise.all([
        prisma.chatReport
            .count({ where: { status: "open", ...since(DISMISSED_KEYS.reports) } })
            .catch(() => 0),
        prisma.safetyCase
            .count({ where: { status: "open", ...since(DISMISSED_KEYS.cases) } })
            .catch(() => 0),
        updateWaiting().catch(() => null),
        apisOff().catch(() => 0)
    ]);
    const update =
        build !== null &&
        marks?.seen?.get("admin.update") !== build &&
        marks?.dismissed.get(DISMISSED_KEYS.update) !== build;
    return { reports, cases, update, apis, total: reports + cases + (update ? 1 : 0) + apis };
}

/**
 * Somebody marked Management entries seen from the app menu: remember what was
 * there, so only something newer counts again. An update is marked by the
 * build it is, a queue by the moment. Switched-off APIs are not marked - a
 * fault stays counted until it is fixed - and are simply skipped.
 */
export async function dismissAdminWaiting(
    userId: string,
    entries: readonly ("reports" | "cases" | "update" | "apis")[]
): Promise<void> {
    const now = new Date().toISOString();
    for (const entry of new Set(entries)) {
        if (entry === "reports" || entry === "cases") {
            await markSeen(userId, DISMISSED_KEYS[entry], now);
        } else if (entry === "update") {
            const build = await announcedBuild();
            if (build) await markSeen(userId, DISMISSED_KEYS.update, build);
        }
    }
}

/**
 * Somebody opened a screen a badge points at: remember what was on it.
 *
 * Written whether or not the account clears badges on a visit, so switching
 * that on later does not raise a badge for something already looked at.
 */
export async function markScreenSeen(userId: string, screen: BadgeScreen): Promise<void> {
    if (screen === "/admin/settings") {
        const build = await announcedBuild();
        if (build) await markSeen(userId, "admin.update", build);
        return;
    }
    await markSeen(userId, "admin.safety", new Date().toISOString());
}
