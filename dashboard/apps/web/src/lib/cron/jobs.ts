/**
 * The work Polaris does on a schedule, and how often each piece of it is due.
 *
 * These bodies used to live inside the `/api/cron/*` routes, which meant the only
 * way to run them was over HTTP with a secret - so on an instance where nobody had
 * wired an external scheduler, none of them ran at all. Some had a lazy fallback on
 * a read path and quietly became "runs while somebody is looking"; the rest simply
 * never happened. Here they are ordinary functions, called by the scheduler on a
 * timer and by the routes when somebody would still rather drive them from outside.
 *
 * Two of them take a lease, because two runners doing them at once costs something
 * real: a second backup of the same world, or a second copy of the same
 * notification. The rest are written to be re-run and several already are, from the
 * screens that sweep them lazily.
 */

import { withLease } from "./lease";
import { prisma } from "@polaris/db";
import { sweepDueBackups } from "@/lib/backups/service";
import { sweepCrashLoops } from "@/lib/apps/games-health";
import { drainQueue } from "@/lib/apps/minecraft/queue-service";
import { getServerPlayers } from "@/lib/apps/minecraft/service";
import { sweepDueDeletions } from "@/lib/scheduled-deletion-service";
import { dispatchDueReminders } from "@/lib/tasks/task-detail-service";
import { sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";
import { isGameServerApp, syncFirewallBans } from "@/lib/apps/games-service";
import { sweepInventorySnapshots } from "@/lib/apps/minecraft/inventory-service";

const MINUTE = 60 * 1000;

export interface ScheduledJob {
    /** Names the job everywhere: the route that triggers it, the lease it takes,
     *  and the line it logs. */
    readonly key: string;
    readonly everyMs: number;
    /** How long a lease is held if the process running this one dies partway
     *  through. Null for the jobs where two runners are harmless. */
    readonly leaseMs: number | null;
    readonly run: () => Promise<unknown>;
}

/** Every owner with an installed app. A blocklist and a schedule are instance-wide
 *  and run on nobody's behalf in particular, so the walk starts from the owners
 *  rather than from a session. */
async function ownersWithApps(): Promise<string[]> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { ownerId: true },
        distinct: ["ownerId"]
    });
    return rows.map((row) => row.ownerId);
}

async function runFirewall(): Promise<{ servers: number; banned: number; kicked: number; allowed: number }> {
    let servers = 0;
    let banned = 0;
    let kicked = 0;
    let allowed = 0;
    for (const ownerId of await ownersWithApps()) {
        const result = await syncFirewallBans(ownerId).catch(() => null);
        if (!result) continue;
        servers += result.servers;
        banned += result.banned;
        kicked += result.kicked;
        allowed += result.allowed;
    }
    return { servers, banned, kicked, allowed };
}

async function runGameSchedules(): Promise<{ started: number; stopped: number }> {
    let started = 0;
    let stopped = 0;
    for (const ownerId of await ownersWithApps()) {
        const swept = await sweepGameSchedules(ownerId).catch(() => null);
        if (!swept) continue;
        started += swept.started;
        stopped += swept.stopped;
    }
    return { started, stopped };
}

async function runGameHealth(): Promise<{ checked: number; stopped: number }> {
    let checked = 0;
    let stopped = 0;
    for (const ownerId of await ownersWithApps()) {
        const swept = await sweepCrashLoops(ownerId).catch(() => null);
        if (!swept) continue;
        checked += swept.checked;
        stopped += swept.stopped;
    }
    return { checked, stopped };
}

async function runInventories(): Promise<{ servers: number; snapshots: number; applied: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { id: true, ownerId: true, catalogId: true }
    });

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
        snapshots += await sweepInventorySnapshots(install.ownerId, install.id, online).catch(() => 0);
    }
    return { servers, snapshots, applied };
}

/**
 * Cadences are set by what going late actually costs, not by how cheap the job is.
 *
 * A reminder is asked for at a minute, so it is checked every minute. A temporary
 * ban is only ever lifted by the firewall walk, so that runs often too - but not
 * every minute, because it opens a connection to each running server and there is
 * no ten-minute cool-off that minds being two minutes long. Backups are hourly at
 * their finest, so five minutes is already far below the granularity anybody can
 * choose, and a deletion scheduled for a date does not care about ten.
 */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
    {
        key: "backups",
        everyMs: Number(process.env.POLARIS_BACKUP_SWEEP_MS) || 5 * MINUTE,
        // Long, because the work is: this is the one that archives worlds and
        // dumps databases. A pass bounds itself, so twice that bound leaves room
        // for the copy in flight when the budget ran out.
        leaseMs: 20 * MINUTE,
        run: sweepDueBackups
    },
    {
        key: "task-reminders",
        everyMs: Number(process.env.POLARIS_REMINDER_SWEEP_MS) || MINUTE,
        leaseMs: 2 * MINUTE,
        run: dispatchDueReminders
    },
    {
        key: "game-firewall",
        everyMs: Number(process.env.POLARIS_GAME_FIREWALL_MS) || 2 * MINUTE,
        leaseMs: null,
        run: runFirewall
    },
    {
        key: "game-schedules",
        everyMs: Number(process.env.POLARIS_GAME_SCHEDULE_MS) || MINUTE,
        leaseMs: null,
        run: runGameSchedules
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
        key: "scheduled-deletions",
        everyMs: Number(process.env.POLARIS_DELETION_SWEEP_MS) || 10 * MINUTE,
        leaseMs: null,
        // No connection id: that argument is the browser-driven path, which is
        // throttled per connection. This is the pass that catches what nobody
        // browsed.
        run: () => sweepDueDeletions()
    }
];

/** Run one job's body, taking its lease first when it has one. Null means another
 *  process is already running it. */
export async function runJobBody(job: ScheduledJob): Promise<unknown> {
    if (job.leaseMs === null) return job.run();
    return withLease(job.key, job.leaseMs, job.run);
}
