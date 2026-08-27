/**
 * Keeping the machine's disk from filling with things nobody wrote.
 *
 * A container store grows on its own. Every build leaves its cache, every pull
 * leaves the layers of the version it replaced, and neither is ever asked for
 * again - so a machine that is only ever deployed to walks up to full over
 * months and then refuses the next deploy. It refuses it, moreover, with a
 * sentence about a rename that no reader would connect to disk space.
 *
 * There has been a button for this for a while, and a button is the wrong shape
 * for it. Somebody has to know the screen exists, know to look before it
 * matters, and be the one holding the phone the evening it does. That is not
 * housekeeping, that is a chore with a deadline nobody is told about. A machine
 * that looks after itself is the only version of this that survives a year.
 *
 * So Polaris does it: on a timer, and again the moment a deploy is refused for
 * room. What it hands back is build cache and layers no tag points at, both of
 * which come back on the next build or pull at the cost of time.
 *
 * What it will never touch is volumes. They are usually the largest thing on the
 * disk and every byte of them is somebody's save file, database or upload, and
 * no timer gets to decide which of those are spare. That line is drawn in the
 * daemon's own allowlist as well as here. It also means the sweep can genuinely
 * fail to help - a disk full of volumes stays full - and the honest answer then
 * is to say so to the person who can decide, rather than to keep pruning nothing
 * every six hours in silence.
 *
 * Server-only. Safe to re-run.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";

import { notify } from "@/lib/notifications/dispatch";
import { getSetting, setSetting } from "@/lib/setting-store";
import { diskFullness, localDisk } from "@/lib/deploy/local-disk";
import { hostSpace, reclaimHostSpace } from "@/lib/deploy/host-space";

/** What was last reported, so a disk that is tight for a month is one message
 *  rather than a hundred and twenty. */
const KEY = "deploy.hostSpaceWarning";

/**
 * How full the disk has to be before anything is handed back.
 *
 * Not zero, deliberately. Cache that is still there is cache the next build
 * reuses, and a machine with room to spare is faster for keeping it - pruning a
 * half-empty disk every six hours buys nothing and costs every build after it.
 * Eighty-five per cent is where the room left stops covering the images a
 * deployment actually pulls.
 */
const HIGH_WATER = 0.85;

/**
 * And where handing it back has not been enough.
 *
 * Above this after a sweep, what is left is not cache - it is volumes, footage,
 * backups, somebody's data - and the only thing that helps is a person deciding
 * what goes. That is worth interrupting them for, because the next thing that
 * happens is a deploy or a recording failing.
 */
const STILL_TIGHT = 0.9;

/** Below this there is nothing worth the call, whatever the disk says. */
const WORTH_RECLAIMING = 256 * 1024 * 1024;

/** What one pass did. */
export interface HousekeepingSweep {
    /** How full the disk was before, 0 to 1, or null where it cannot be read. */
    readonly before: number | null;
    readonly after: number | null;
    /** Bytes the daemon actually handed back. */
    readonly freed: number;
    /** Whether it did anything at all. */
    readonly reclaimed: boolean;
}

/**
 * Whether this disk is tight enough to be worth handing room back, and there is
 * room to hand back.
 *
 * Both halves matter and they fail differently: a full disk with nothing loose
 * on it is a person's problem, and a disk with room to spare does not need its
 * build cache thrown away to prove a point.
 */
export function shouldReclaim(
    fullness: number | null,
    reclaimable: number | null,
    highWater: number = HIGH_WATER
): boolean {
    if (fullness === null || fullness < highWater) return false;
    return (reclaimable ?? 0) >= WORTH_RECLAIMING;
}

/**
 * Hand back what nothing is using, if the disk is tight enough to want it.
 *
 * Reads the disk again afterwards rather than trusting the estimate: what a
 * prune removes is decided when it runs, and the number worth acting on is the
 * one the filesystem reports once it has.
 */
export async function sweepHostSpace(): Promise<HousekeepingSweep> {
    const disk = await localDisk();
    const before = disk ? diskFullness(disk) : null;

    const store = await hostSpace();
    if (!shouldReclaim(before, store?.reclaimable ?? null)) {
        // Still worth saying something when the disk is tight and there was
        // nothing to take: that is the case a person has to settle, and it is
        // exactly the one that would otherwise pass in silence every six hours.
        if (before !== null && before >= STILL_TIGHT) await warn(before, 0);
        else await clearWarning();
        return { before, after: before, freed: 0, reclaimed: false };
    }

    const freed = (await reclaimHostSpace()) ?? 0;
    const settled = await localDisk();
    const after = settled ? diskFullness(settled) : before;

    if (after !== null && after >= STILL_TIGHT) await warn(after, freed);
    else await clearWarning();
    return { before, after, freed, reclaimed: true };
}

/**
 * Free room because a deploy has just been refused for the want of it, and say
 * whether that is worth trying again.
 *
 * The one moment where pruning is unambiguously right whatever the disk says:
 * something has already failed, and every byte of build cache on the machine is
 * worth less than the deploy that cannot land. Reported back rather than
 * retried here, so the caller decides - a second attempt belongs to whoever owns
 * the deploy, not to a housekeeping module.
 */
export async function reclaimForDeploy(): Promise<{ freed: number; worthRetrying: boolean }> {
    const freed = (await reclaimHostSpace()) ?? 0;
    return { freed, worthRetrying: freed > 0 };
}

/**
 * Tell the administrators the machine is out of room and Polaris has done what
 * it can.
 *
 * Every administrator rather than one person: this is the deployment's problem
 * and whoever opens the dashboard first should see it, which is the same rule
 * the router advice follows.
 *
 * Once it reaches here nothing automatic will help - what is left is data
 * somebody put there - so it is marked as needing a person. Said once per state
 * rather than once per pass: a disk that stays at ninety-one per cent for a
 * month is one message, and it is said again only when it gets worse or clears.
 */
async function warn(fullness: number, freed: number): Promise<void> {
    try {
        // Banded, so drifting between 90.4% and 90.6% is not news, and crossing
        // into the next five points is.
        const band = `tight:${Math.floor(fullness * 20)}`;
        if ((await getSetting(KEY)) === band) return;
        await setSetting(KEY, band);

        const admins = await prisma.user
            .findMany({ where: { isAdmin: true, ...VISIBLE_USER }, select: { id: true } })
            .catch(() => []);
        await Promise.all(
            admins.map((admin) =>
                notify({
                    userId: admin.id,
                    event: "server.space",
                    title: `This server's disk is ${Math.round(fullness * 100)}% full`,
                    body:
                        freed > 0
                            ? "Polaris handed back everything nothing was using. What is left is volumes and the files somebody put in them, and only a person can decide what goes."
                            : "There was nothing left to hand back. What is using it is volumes and the files somebody put in them, and only a person can decide what goes.",
                    audience: "admins",
                    actionRequired: true,
                    href: "/apps/servers"
                })
            )
        );
    } catch (error) {
        console.error("polaris: could not report a full disk:", error);
    }
}

/** The disk came back under the mark, so the next time it goes over is news
 *  again. Nothing is announced for it: a problem that solved itself while
 *  nobody was looking is not worth a notification. */
async function clearWarning(): Promise<void> {
    if ((await getSetting(KEY)) !== null) await setSetting(KEY, null);
}
