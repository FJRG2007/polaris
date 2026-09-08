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
 *   somebody has read and not settled is still a report, and a badge that
 *   cleared on being looked at would say the queue was empty while it was full.
 * - **An update nothing will install on its own.** A deployment set to install
 *   at three in the morning has no work for anybody, so it is not counted; one
 *   with automatic updates off has a person in the loop by definition, and that
 *   person is the one this badge is for.
 *
 * Deliberately cheap: two counts and two settings reads, no network. The update
 * check itself is a registry call and belongs to the watcher that already makes
 * it on a loop - this reads what that left behind, which also means it survives
 * a container restart, where the in-memory status cache does not.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { getSetting } from "@/lib/setting-store";
import { getAutoUpdatePolicy } from "@/lib/update-watcher";

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
    /** The three as one number, which is what a badge has room for. */
    readonly total: number;
}

export const NOTHING_WAITING: AdminWaiting = {
    reports: 0,
    cases: 0,
    update: false,
    total: 0
};

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

async function updateWaiting(): Promise<boolean> {
    const running = loadEnv().POLARIS_BUILD_SHA ?? null;
    if (!running) return false;
    const [announced, policy] = await Promise.all([
        getSetting(ANNOUNCED_KEY),
        getAutoUpdatePolicy()
    ]);
    return updateIsWaiting({
        running,
        announced: announced?.split(" ")[0] ?? null,
        autoUpdate: policy.mode
    });
}

/** Everything above, in one read. Best-effort per part: a settings table that
 *  will not answer must not take the whole badge - and a badge that is short by
 *  one is better than a management screen that will not draw. */
export async function adminWaiting(): Promise<AdminWaiting> {
    const [reports, cases, update] = await Promise.all([
        prisma.chatReport.count({ where: { status: "open" } }).catch(() => 0),
        prisma.safetyCase.count({ where: { status: "open" } }).catch(() => 0),
        updateWaiting().catch(() => false)
    ]);
    return { reports, cases, update, total: reports + cases + (update ? 1 : 0) };
}
