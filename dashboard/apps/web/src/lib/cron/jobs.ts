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
import { sweepExpiredSends } from "@/lib/vault/sends";
import { sweepDueBackups } from "@/lib/backups/service";
import { sweepRetention } from "@/lib/retention-service";
import { pruneTelemetry } from "@/lib/telemetry/store";
import { sweepCrashLoops } from "@/lib/apps/games-health";
import { expireTransfers } from "@/lib/drive-transfer-service";
import { drainQueue } from "@/lib/apps/minecraft/queue-service";
import { getServerPlayers } from "@/lib/apps/minecraft/service";
import { sweepDueScheduledMessages } from "@/lib/chat/scheduled";
import { sweepConnectionHealth } from "@/lib/connections/health";
import { sweepCameraReachability } from "@/lib/home/reachability";
import { liftExpiredSuspensions } from "@/lib/user-admin-service";
import { sweepSilentSessions } from "@/lib/agents/session-runtime";
import { sweepDueDeletions } from "@/lib/scheduled-deletion-service";
import { sweepGameActivity } from "@/lib/apps/games-activity-service";
import { dispatchDueReminders } from "@/lib/tasks/task-detail-service";
import { syncTracker, trackersToSync } from "@/lib/tasks/trackers/sync";
import { sweepContinuousRecording, sweepHomeRetention } from "@/lib/home/sweeps";
import { sweepInventorySnapshots } from "@/lib/apps/minecraft/inventory-service";
import { sweepHostSpace, sweepServerSpace } from "@/lib/deploy/host-housekeeping";
import { sweepExpired as sweepExpiredSignins } from "@/lib/agents/signin-runtime";
import { runGameRoutines, sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";
import { isGameServerApp, sweepGameReach, syncFirewallBans } from "@/lib/apps/games-service";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Every connected tracker, one pass each. One that fails leaves the reason on
 *  itself and does not stop the others: a Jira that is down is not a reason for
 *  a Linear to go stale. */
async function syncTrackers(): Promise<number> {
    const ids = await trackersToSync();
    // Caught here as well as inside the sync. `syncTracker` puts the reason on the
    // connection and answers rather than throwing, and this is what makes that
    // promise true from the schedule even when something under it breaks it.
    for (const id of ids) await syncTracker(id).catch(() => undefined);
    return ids.length;
}

/**
 * Both disks Polaris is responsible for: its own box, and every server it
 * deploys to.
 *
 * One job rather than two because they are one question - "is anything Polaris
 * put on a disk still there for no reason" - and because a second entry would be
 * a second thing to notice was missing. The server pass runs even when the local
 * one found nothing to do: they fill at completely different rates, and the local
 * box is usually the one with room.
 */
async function sweepEveryDisk(): Promise<{ local: number; servers: number }> {
    const local = await sweepHostSpace();
    const servers = await sweepServerSpace().catch(() => []);
    return { local: local.freed, servers: servers.reduce((total, one) => total + one.freed, 0) };
}

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
}> {
    let started = 0;
    let stopped = 0;
    let arrived = 0;
    let left = 0;
    for (const ownerId of await ownersWithApps()) {
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
    return { started, stopped, arrived, left };
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
        snapshots += await sweepInventorySnapshots(install.ownerId, install.id, online).catch(
            () => 0
        );
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
        key: "retention",
        // Hourly. What this removes is a record nobody is waiting on, and the
        // periods are measured in days - a pass that runs an hour late has
        // removed exactly the same rows.
        everyMs: Number(process.env.POLARIS_RETENTION_SWEEP_MS) || HOUR,
        // Unleased. Each pass names the rows it is deleting by id, so two
        // runners doing it at once delete the same rows and one of them counts
        // zero. Nothing is written twice and nothing is lost.
        leaseMs: null,
        run: sweepRetention
    },
    {
        key: "telemetry-prune",
        // Hourly, like retention and for the same reason: what it removes is a
        // stack trace older than the project keeps, and a pass that runs late
        // removes exactly the same rows. The daily counts are not touched, so a
        // chart does not develop a hole where the events used to be.
        everyMs: Number(process.env.POLARIS_TELEMETRY_PRUNE_MS) || HOUR,
        // Unleased. Two runners delete the same rows and one of them counts
        // zero; nothing is written and nothing is lost.
        leaseMs: null,
        run: pruneTelemetry
    },
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
        key: "connection-health",
        // Slow on purpose. A token expires on a date rather than at a moment,
        // nothing here is undone by hearing about it four hours late, and every
        // pass is a request per linked account to somebody else's API.
        everyMs: Number(process.env.POLARIS_CONNECTION_HEALTH_MS) || 4 * HOUR,
        // Leased, and for longer than the gap between passes as every lease
        // here is: two runners would each raise the announcement before either
        // wrote that it had been made, which is the one thing this must not do.
        leaseMs: 5 * HOUR,
        run: sweepConnectionHealth
    },
    {
        key: "chat-scheduled",
        // Every minute, and the floor on how far ahead a message may be
        // scheduled is the same minute: anything finer would be a promise the
        // sweep cannot keep, and anything coarser is a message that goes late by
        // as much as the gap.
        everyMs: Number(process.env.POLARIS_CHAT_SCHEDULE_MS) || MINUTE,
        // Leased, because sending twice is the one thing this must not do.
        leaseMs: 5 * MINUTE,
        run: sweepDueScheduledMessages
    },
    {
        key: "task-trackers",
        // A connected Linear or Jira is read on a timer rather than pushed to:
        // both can push, and neither can push to a Polaris that is not on the
        // public internet - which most of them are not. Two minutes is as far
        // behind somebody else's board as anybody notices.
        everyMs: Number(process.env.POLARIS_TRACKER_SYNC_MS) || 2 * MINUTE,
        // Leased, because two passes over one connection would create the same
        // issue as two tasks: the link that stops that is written after the task.
        leaseMs: 10 * MINUTE,
        run: syncTrackers
    },
    {
        key: "agent-sessions",
        // A session reports through its own hooks, so silence is the only signal
        // there is that its container was reaped or its server went away. Five
        // minutes rather than thirty, because the other half of this pass is a
        // sign-in container somebody opened and walked away from, which holds
        // that account's only slot: the next attempt is refused until this
        // clears it, and that is a wait a person is sitting through.
        everyMs: Number(process.env.POLARIS_SESSION_SWEEP_MS) || 5 * MINUTE,
        // Leased now that it tears containers down. Two runners removing the
        // same one race each other, and the one that loses fails on a container
        // the other already took.
        leaseMs: 10 * MINUTE,
        run: sweepAgentLeftovers
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
        // Leased now that the same pass records who was playing. A duplicate
        // schedule decision was harmless and a duplicate history is not: two
        // runners write two readings a millisecond apart and open a second visit
        // for everybody already on.
        leaseMs: 5 * MINUTE,
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
        key: "game-reach",
        // Two minutes, because it is only ever answering a question the operator
        // has already been told the answer arrives on its own: a port opened while
        // the server was still starting, or a forward made after the tab was
        // closed. Nothing is knocked on once it is proven.
        everyMs: Number(process.env.POLARIS_GAME_REACH_MS) || 2 * MINUTE,
        // Unleased like the other read-only sweeps: two runners knock on the same
        // port and write the same timestamp, which is the same outcome.
        leaseMs: null,
        run: sweepGameReach
    },
    {
        key: "scheduled-deletions",
        everyMs: Number(process.env.POLARIS_DELETION_SWEEP_MS) || 10 * MINUTE,
        leaseMs: null,
        // No connection id: that argument is the browser-driven path, which is
        // throttled per connection. This is the pass that catches what nobody
        // browsed.
        run: () => sweepDueDeletions()
    },
    {
        key: "vault-sends",
        everyMs: 15 * MINUTE,
        // No lease: deleting what is already past its date is the same work
        // however many runners do it, and a second one finds nothing left.
        leaseMs: null,
        // A Send's deletion date is a promise to whoever made it. Enforcing it
        // only when somebody opens the link would mean a Send nobody opened
        // sitting there forever, which is the case it was set for.
        run: () => sweepExpiredSends()
    },
    {
        key: "home-recording",
        // A minute, and each pass only tops up: a camera already writing a
        // segment is left alone, and one that has just finished starts the next.
        everyMs: Number(process.env.POLARIS_HOME_RECORDING_MS) || MINUTE,
        // Leased, because two runners would each start a segment on the same
        // camera and write the same footage to the disk twice.
        leaseMs: 20 * MINUTE,
        run: sweepContinuousRecording
    },
    {
        key: "home-availability",
        // A minute. A camera that has gone quiet is only useful to know about
        // quickly, and the pass is one cached frame per camera - which is what
        // the wall already asks for whenever somebody has it open.
        everyMs: Number(process.env.POLARIS_HOME_AVAILABILITY_MS) || MINUTE,
        // Leased: two runners asking the same camera at the same moment would
        // each decide it was the one to write the outage down, and the house
        // would be told twice.
        leaseMs: 5 * MINUTE,
        run: sweepCameraReachability
    },
    {
        key: "home-retention",
        // Footage is the only part of the house that grows whether or not anybody
        // uses it, so this is the job that decides whether a disk fills.
        everyMs: Number(process.env.POLARIS_HOME_RETENTION_MS) || 15 * MINUTE,
        // Leased: it removes files, and two runners racing on the same clip means
        // one of them fails on a file the other already dropped. Longer than the
        // cadence, so a pass that runs over does not have the next one start
        // beside it.
        leaseMs: 30 * MINUTE,
        run: sweepHomeRetention
    },
    {
        key: "host-space",
        // Six hours. What this cleans up accumulates over weeks, not minutes,
        // and the cache it hands back is cache the next build would have reused
        // - so running it often costs every build to save nothing.
        everyMs: Number(process.env.POLARIS_HOST_SPACE_MS) || 6 * 60 * MINUTE,
        // Leased for longer than the gap between passes, like every other job
        // here: two runners pruning the same store race each other onto the same
        // records, and one of them fails on what the other already took.
        leaseMs: 7 * 60 * MINUTE,
        run: sweepEveryDisk
    },
    {
        key: "drive-transfers",
        // Hourly, because a fortnight is what an offer stands for and nothing is
        // waiting on the minute it stops. What this ends is an offer the
        // recipient already cannot see - it still counts against how many the
        // sender may have out, and still sits in their own list under "waiting
        // to be answered" with no way but Take back to clear it.
        everyMs: Number(process.env.POLARIS_TRANSFER_SWEEP_MS) || HOUR,
        // Unleased: it names the rows it changes by their state, so a second
        // runner finds nothing left.
        leaseMs: null,
        run: expireTransfers
    },
    {
        key: "suspensions",
        // A minute, because the thing waiting on it is a person being told they
        // are still shut out of an account that is due back.
        everyMs: Number(process.env.POLARIS_SUSPENSION_SWEEP_MS) || MINUTE,
        // Unleased: it names the rows it would change, so a second runner finds
        // nothing left to do.
        leaseMs: null,
        run: liftExpiredSuspensions
    }
];

/** Run one job's body, taking its lease first when it has one. Null means another
 *  process is already running it. */
export async function runJobBody(job: ScheduledJob): Promise<unknown> {
    if (job.leaseMs === null) return job.run();
    return withLease(job.key, job.leaseMs, job.run);
}

/**
 * The machines an agent left behind.
 *
 * Two sweeps rather than one job each, because they are the same fact from two
 * directions: something Polaris started for a person is still running and the
 * person is not coming back. A session whose machine stopped reporting has no
 * one watching it, and a sign-in container is abandoned far more often than it
 * is finished - somebody opens it, reads what it wants, and goes to find the
 * browser they are signed in on.
 *
 * Neither failing may stop the other: they touch different machines, and a
 * daemon that will not answer about one has nothing to do with the other.
 */
async function sweepAgentLeftovers(): Promise<void> {
    await sweepSilentSessions().catch(() => 0);
    await sweepExpiredSignins().catch(() => 0);
}
