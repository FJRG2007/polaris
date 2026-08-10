/**
 * One runner at a time, across processes.
 *
 * The scheduler's own re-entrancy flag only covers one Node process, and there is
 * routinely more than one: two web containers serve at once during a rollover,
 * and an operator who followed the old advice still has a crontab pointed at
 * `/api/cron/*`. For most of the work that is harmless - the sweeps were written
 * to be re-run. For the two that are not, doubling up is expensive and silent:
 * "Two sweeps over the same worlds would each see the other's archive as the
 * newest and take one anyway, which is how a nightly schedule quietly becomes two
 * backups a night."
 *
 * So a lease, on the `Setting` table, which already carries this instance's other
 * global odds and ends. The unique key makes the first insert an election, and
 * after that the conditional update is a compare-and-swap the database resolves
 * on its own - the same trick `update-watcher` and `address-health` use to decide
 * who announces a change, put to work here on the work itself rather than on the
 * announcement.
 *
 * The stored value is an expiry and a nonce. The expiry is what lets a lease
 * survive the process that took it dying mid-job - nobody is left holding it
 * forever - and the nonce is what stops that same crash from turning into a worse
 * bug: without it, a slow holder that finally finishes would release a lease it
 * had already lost, handing the job to a third process while the second is still
 * running it. Releasing your own token or nothing at all is the whole point.
 */

import { prisma } from "@polaris/db";
import { randomBytes } from "node:crypto";

/** ISO-8601 UTC is fixed width and sorts lexicographically, which is what lets
 *  the expiry be compared with `lt` on a text column. */
function stamp(at: number): string {
    return new Date(at).toISOString();
}

function token(expiresAt: number): string {
    return `${stamp(expiresAt)} ${randomBytes(9).toString("hex")}`;
}

/** Take the lease, or say that somebody else has it. */
async function acquire(key: string, ttlMs: number, now: number): Promise<string | null> {
    const mine = token(now + ttlMs);
    try {
        await prisma.setting.create({ data: { key, value: mine, scope: "global" } });
        return mine;
    } catch {
        // The row exists, so this is a takeover rather than a first run: it lands
        // only if what is there has expired, and only for whichever caller gets
        // there first. Everyone else sees a count of zero and stands down.
        const won = await prisma.setting.updateMany({
            where: { key, value: { lt: stamp(now) } },
            data: { value: mine }
        });
        return won.count === 1 ? mine : null;
    }
}

/** Give it back, but only if it is still ours. */
async function release(key: string, mine: string): Promise<void> {
    // An expiry in the past rather than deleting the row: the next caller then
    // takes it through the ordinary compare-and-swap instead of racing to insert.
    await prisma.setting
        .updateMany({ where: { key, value: mine }, data: { value: stamp(0) } })
        .catch(() => undefined);
}

/**
 * Run `work` if this process can take the lease named by `key`, and return null
 * without running it if it cannot.
 *
 * `ttlMs` is how long the lease is held if this process dies partway through, so
 * it wants to be comfortably longer than the work can take: the cost of setting
 * it too high is a job that pauses for a while after a crash, and the cost of
 * setting it too low is the double-run the lease exists to prevent.
 */
export async function withLease<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T | null> {
    const row = `cron.lease.${key}`;
    const mine = await acquire(row, ttlMs, Date.now());
    if (!mine) return null;
    try {
        return await work();
    } finally {
        await release(row, mine);
    }
}
