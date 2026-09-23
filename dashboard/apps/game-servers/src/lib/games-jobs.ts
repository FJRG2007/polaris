/**
 * The scheduled work Game servers runs.
 *
 * Registered through the app extension registry, so it only runs while Game
 * servers is installed and core's job table never names it.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";

const { isGameServerApp } = host.appsCatalog;
const { ownersWithApps } = host.cronOwners;
type AppJob = AppHostTypes["AppJob"];

// The services behind each job are loaded when the job runs, not when the job
// table is read: the table is read by core's scheduler at startup.
const games = () => import("./games-service");
const worlds = () => import("./minecraft/world-service");
const schedules = () => import("./minecraft/schedule-service");

const MINUTE = 60 * 1000;

/** How long one activity pass may spend starting owners. Half the lease, so the
 *  owner still being walked when it runs out has as long again to finish inside
 *  it. */
const GAME_ACTIVITY_BUDGET_MS = 10 * MINUTE;

async function runFirewall(): Promise<{
    servers: number;
    banned: number;
    kicked: number;
    allowed: number;
}> {
    let servers = 0;
    let banned = 0;
    let kicked = 0;
    let allowed = 0;
    for (const ownerId of await ownersWithApps()) {
        const { syncFirewallBans } = await games();
        const result = await syncFirewallBans(ownerId).catch(() => null);
        if (!result) continue;
        servers += result.servers;
        banned += result.banned;
        kicked += result.kicked;
        allowed += result.allowed;
    }
    return { servers, banned, kicked, allowed };
}

/**
 * Ask every game server who is on it, write that down, and then apply the schedules
 * with the answer already in hand.
 *
 * One pass rather than two, because asking is the expensive half - a command inside
 * a container, per server - and the schedule sweep already takes a map of counts
 * somebody else has paid for. Two jobs on the same minute would ask every server
 * twice for the same number.
 */
async function runGameActivity(): Promise<{
    started: number;
    stopped: number;
    arrived: number;
    left: number;
    skipped: number;
}> {
    const owners = await ownersWithApps();
    const { sweepGameActivity } = await import("./games-activity-service");
    const { runGameRoutines, sweepGameSchedules } = await schedules();
    // Bounded like the backup sweep, and now for the same reason: a scheduled
    // stop writes the world out and takes a copy of it first, which is `tar` over
    // a whole world inside the container and is allowed ninety seconds per server
    // before it gives up. Four servers going quiet on the same night is six
    // minutes in one pass, and a pass that outlives its lease releases it - which
    // starts a second runner that re-reads who is playing and opens a second visit
    // for everybody already on, the exact duplicate this job's lease exists to
    // prevent. An owner this pass did not reach is reached on the next tick, a
    // minute later, from the same state on disk.
    const until = Date.now() + GAME_ACTIVITY_BUDGET_MS;
    let started = 0;
    let stopped = 0;
    let arrived = 0;
    let left = 0;
    let skipped = 0;
    for (const [index, ownerId] of owners.entries()) {
        // Before the owner rather than during them: a budget may decide what not
        // to begin, and must never leave a server stopped without the copy that
        // was the reason for stopping it slowly.
        if (Date.now() >= until) {
            skipped = owners.length - index;
            break;
        }
        const now = new Date();
        const activity = await sweepGameActivity(ownerId, now).catch(() => null);
        const swept = await sweepGameSchedules(ownerId, now, {
            ...(activity ? { known: activity.known } : {})
        }).catch(() => null);
        // After the windows, not before: a routine that restarts a server should
        // not race the sweep that was about to stop it for being empty.
        for (const installedAppId of activity?.known.keys() ?? []) {
            await runGameRoutines(ownerId, installedAppId, now).catch(() => 0);
        }
        if (activity) {
            arrived += activity.arrived;
            left += activity.left;
        }
        if (swept) {
            started += swept.started;
            stopped += swept.stopped;
        }
    }
    return { started, stopped, arrived, left, skipped };
}

/**
 * Take the world copies that are due, across every owner.
 *
 * Its own job rather than a line in `backups`: that one is driven by
 * `nextDueAt` on a protected resource, and a game world is not one - the
 * schedule lives in the install's own config and the only thing that says when
 * the last copy was taken is the archive sitting next to the world. Without
 * this the schedule on the Backups card is a date nothing ever acts on, which is
 * worse than no schedule at all.
 */
/** How long one pass may spend starting copies. Half the lease, so the copy that
 *  was in flight when the budget ran out still has room to finish inside it. */
const WORLD_BACKUP_BUDGET_MS = 10 * MINUTE;

async function runWorldBackups(): Promise<{
    taken: number;
    pruned: number;
    failed: number;
    left: number;
}> {
    const owners = await ownersWithApps();
    const { sweepWorldBackups } = await worlds();
    // Bounded like the sibling sweep, and for the reason its lease exists: `tar`
    // over a world takes as long as the world is big, a pass walks every owner,
    // and a pass that outlives the scheduler's own stuck-after mark releases the
    // lease and the guard together - which starts a second runner archiving the
    // same world the first one is still archiving. The budget is what keeps the
    // pass inside its lease; an owner it did not reach is reached ten minutes
    // later, because the schedule is re-read from what is on disk every time.
    const until = Date.now() + WORLD_BACKUP_BUDGET_MS;
    let taken = 0;
    let pruned = 0;
    let failed = 0;
    let left = 0;
    for (const [index, ownerId] of owners.entries()) {
        // Before the work rather than after it: a budget can decide what not to
        // start, and must never cut a copy already being written in half.
        if (Date.now() >= until) {
            left = owners.length - index;
            break;
        }
        const swept = await sweepWorldBackups(ownerId).catch(() => []);
        for (const server of swept) {
            if (server.name) taken += 1;
            if (server.error) failed += 1;
            pruned += server.pruned.length;
        }
    }
    return { taken, pruned, failed, left };
}

async function runGameHealth(): Promise<{
    checked: number;
    stopped: number;
    memoryRaised: number;
}> {
    const { sweepCrashLoops } = await import("./games-health");
    // Beside it rather than inside it: one answers "is this server failing to
    // start", the other "has this server outgrown what it was given", and a
    // server can be perfectly healthy and still be out of memory.
    const { sweepMemoryPlans } = await import("./games-memory");
    let checked = 0;
    let stopped = 0;
    let memoryRaised = 0;
    for (const ownerId of await ownersWithApps()) {
        const swept = await sweepCrashLoops(ownerId).catch(() => null);
        if (swept) {
            checked += swept.checked;
            stopped += swept.stopped;
        }
        const memory = await sweepMemoryPlans(ownerId).catch(() => null);
        if (memory) memoryRaised += memory.raised;
    }
    return { checked, stopped, memoryRaised };
}

async function runInventories(): Promise<{ servers: number; snapshots: number; applied: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { id: true, ownerId: true, catalogId: true }
    });

    const { getServerPlayers } = await import("./minecraft/service");
    const { drainQueue } = await import("./minecraft/queue-service");
    const { sweepInventorySnapshots } = await import("./minecraft/inventory-service");
    let servers = 0;
    let snapshots = 0;
    let applied = 0;
    for (const install of installs) {
        if (!isGameServerApp(install.catalogId)) continue;
        // Who is on, asked once and used twice. A server that is not answering has
        // nobody on it as far as this is concerned, and neither pass has anything
        // to do - which is the common case and costs one refused connection.
        const online = await getServerPlayers(install.ownerId, install.id)
            .then((status) => (status.answering ? status.players.players : []))
            .catch(() => [] as string[]);
        if (online.length === 0) continue;
        servers += 1;
        const report = await drainQueue(install.ownerId, install.id, online).catch(() => null);
        applied += report?.applied ?? 0;
        snapshots += await sweepInventorySnapshots(install.ownerId, install.id, online).catch(
            () => 0
        );
    }
    return { servers, snapshots, applied };
}

/** The jobs, with the keys their leases were always taken under. */
/**
 * Optimize the worlds of servers that are already stopped.
 *
 * Never stops one to do it - see `trimDue`. So this is a sweep that usually finds
 * nothing, which is the intended shape: the moment worth using is a server that
 * is off for its own reasons, and a background job does not get to create that
 * moment by turning somebody off.
 */
async function runWorldTrims(): Promise<{ done: number; servers: number }> {
    const { sweepWorldTrim } = await import("./minecraft/world-trim-service");
    let done = 0;
    let servers = 0;
    for (const ownerId of await ownersWithApps()) {
        const installs = await prisma.installedApp.findMany({
            where: { ownerId, status: { not: "removed" }, catalogId: "minecraft", applicationId: { not: null } },
            select: { id: true }
        });
        for (const install of installs) {
            servers += 1;
            if (await sweepWorldTrim(ownerId, install.id).catch(() => false)) done += 1;
        }
    }
    return { done, servers };
}

export function gameJobTable(): readonly AppJob[] {
    return [
        {
            key: "game-firewall",
            everyMs: Number(process.env.POLARIS_GAME_FIREWALL_MS) || 2 * MINUTE,
            leaseMs: null,
            run: runFirewall
        },
        {
            key: "game-schedules",
            everyMs: Number(process.env.POLARIS_GAME_SCHEDULE_MS) || MINUTE,
            // Leased now that the same pass records who was playing. A duplicate
            // schedule decision was harmless and a duplicate history is not: two
            // runners write two readings a millisecond apart and open a second visit
            // for everybody already on.
            //
            // Longer than the cadence by a wide margin, because a stop on this path
            // writes the world out and copies it before the container goes down, and
            // that is minutes rather than seconds on a world people have been playing.
            // The lease is only held while a pass is actually in flight, so a normal
            // one - which is over in seconds - still runs every minute; what this
            // buys is that a slow one is not overtaken by the next. Twice the pass's
            // own budget, and under the scheduler's stuck-after mark.
            leaseMs: 20 * MINUTE,
            run: runGameActivity
        },
        {
            key: "game-inventories",
            everyMs: Number(process.env.POLARIS_GAME_INVENTORY_MS) || 5 * MINUTE,
            leaseMs: null,
            run: runInventories
        },
        {
            key: "game-health",
            // Every minute, because what it catches costs a core and a disk for as
            // long as nobody catches it, and because the person waiting on that server
            // is watching it say "starting" the whole time.
            everyMs: Number(process.env.POLARIS_GAME_HEALTH_MS) || MINUTE,
            // Leased, unlike the other game sweeps: this one stops a container and
            // writes a notification about it, and two runners doing that is a server
            // stopped twice and somebody told twice.
            leaseMs: 5 * MINUTE,
            run: runGameHealth
        },
        {
            key: "game-world-backups",
            // Every ten minutes, and the schedule itself decides whether anything is
            // due - the shortest one on offer is hourly, so this is only ever asking a
            // question it usually answers no to, and it makes a daily copy land within
            // ten minutes of when the card said it would.
            everyMs: Number(process.env.POLARIS_GAME_BACKUP_SWEEP_MS) || 10 * MINUTE,
            // Leased, and for longer than the gap: this archives a world with `tar`
            // inside the container, and two runners doing that at once is two copies
            // of the same world competing for the same disk. Twice the pass's own
            // budget, and under the scheduler's stuck-after mark - a lease as long as
            // that mark expires both guards at once, which is the second runner this
            // is here to prevent.
            leaseMs: 20 * MINUTE,
            run: runWorldBackups
        },
        {
            key: "game-world-trim",
            // Hourly, because what it is looking for is a server that happens to be
            // stopped, and that is a state that lasts hours rather than seconds. A
            // pass over a running fleet is one query and no work at all.
            everyMs: Number(process.env.POLARIS_GAME_TRIM_SWEEP_MS) || 60 * MINUTE,
            // Leased for the same reason the backup sweep is: this rewrites region
            // files, and two runners rewriting the same world is the one thing the
            // optimizer itself cannot defend against.
            leaseMs: 30 * MINUTE,
            run: runWorldTrims
        },
        {
            key: "game-reach",
            // Two minutes, because it is only ever answering a question the operator
            // has already been told the answer arrives on its own: a port opened while
            // the server was still starting, or a forward made after the tab was
            // closed. Nothing is knocked on once it is proven.
            everyMs: Number(process.env.POLARIS_GAME_REACH_MS) || 2 * MINUTE,
            // Unleased like the other read-only sweeps: two runners knock on the same
            // port and write the same timestamp, which is the same outcome.
            leaseMs: null,
            run: async () => (await games()).sweepGameReach()
        }
    ];
}
