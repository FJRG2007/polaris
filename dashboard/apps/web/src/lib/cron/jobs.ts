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
import { wakeSnoozed } from "@/lib/mailbox/messages";
import { sweepExpiredSends } from "@/lib/vault/sends";
import { sweepDueSends } from "@/lib/mailbox/compose";
import { pruneTelemetry } from "@/lib/telemetry/store";
import { runAutoscale } from "@/lib/deploy/autoscaler";
import { sweepDueBackups } from "@/lib/backups/service";
import { sweepRetention } from "@/lib/retention-service";
import { sweepCrashLoops } from "@/lib/apps/games-health";
import { runSleepPass } from "@/lib/deploy/sleep-service";
import { sweepOrphanUploads } from "@/lib/mailbox/uploads";
import { tickServiceCrons } from "@/lib/deploy/service-cron";
import { runDesiredStatePass } from "@/lib/deploy/desired-state";
import { scanServiceUpdates } from "@/lib/deploy/update-scan";
import { expireTransfers } from "@/lib/drive-transfer-service";
import { drainQueue } from "@/lib/apps/minecraft/queue-service";
import { getServerPlayers } from "@/lib/apps/minecraft/service";
import { runMailServerPass } from "@/lib/mail-server/scheduled";
import { accountsToSync, syncAccount } from "@/lib/mailbox/sync";
import { sweepDueScheduledMessages } from "@/lib/chat/scheduled";
import { sweepConnectionHealth } from "@/lib/connections/health";
import { pruneDriveJobs, sweepDriveJobs } from "@/lib/drive-jobs";
import { sweepCameraReachability } from "@/lib/home/reachability";
import { liftExpiredSuspensions } from "@/lib/user-admin-service";
import { sweepSilentSessions } from "@/lib/agents/session-runtime";
import { sealAuditChain, verifyAuditChain } from "@/lib/audit-chain";
import { sweepDueDeletions } from "@/lib/scheduled-deletion-service";
import { sweepGameActivity } from "@/lib/apps/games-activity-service";
import { dispatchDueReminders } from "@/lib/tasks/task-detail-service";
import { syncTracker, trackersToSync } from "@/lib/tasks/trackers/sync";
import { reconcilePrivateNetworks } from "@/lib/deploy/service-networks";
import { ensureManagedCertificates } from "@/lib/tls/managed-certificates";
import { captureRuntimeLogs, pruneRuntimeLogs } from "@/lib/deploy/runtime-logs";
import { backfillCategories, sweepExpiredCodes } from "@/lib/mailbox/categories";
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
 * Every mailbox due a pass, one each.
 *
 * A mailbox that fails leaves the reason on itself and does not stop the next
 * one: somebody's expired password is not a reason for everybody else's mail to
 * stop arriving. `syncAccount` already answers rather than throwing, and the
 * catch here is the second line rather than the first.
 */
async function syncMailboxes(): Promise<number> {
    const ids = await accountsToSync();
    for (const id of ids) await syncAccount(id).catch(() => undefined);
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
        key: "audit-seal",
        // Every minute, so an entry is part of the chain within a minute of being
        // written - the window in which deleting it leaves no trace. Free once
        // there is nothing unsealed.
        everyMs: MINUTE,
        // Leased, and this one matters more than most: it is the chain's only
        // writer, and two passes at once would hand out the same places twice.
        leaseMs: 5 * MINUTE,
        run: async () => ({ sealed: await sealAuditChain() })
    },
    {
        key: "audit-verify",
        // Daily. Verification walks the whole chain, which is the one expensive
        // read here, and the answer is kept for the screen that shows it.
        everyMs: 24 * HOUR,
        // Longer than the gap between passes, as every lease here is.
        leaseMs: 25 * HOUR,
        run: async () => {
            const result = await verifyAuditChain();
            return { ok: result.ok, checked: result.checked };
        }
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
        key: "drive-jobs",
        // The backstop behind the kick a button press gives a new job: one whose
        // worker died mid-batch, one queued by a process that then restarted, one
        // left running by a container that went away during a rollover. Often
        // enough that a lost job is picked up in a minute rather than an hour.
        everyMs: Number(process.env.POLARIS_DRIVE_JOBS_MS) || MINUTE,
        // Unleased. Each job is taken under its own lease inside the sweep, which
        // is the lock that matters - two runners here find nothing to take and
        // return.
        leaseMs: null,
        run: sweepDriveJobs
    },
    {
        key: "drive-jobs-prune",
        // Daily. A finished job is worth keeping only long enough for the screen
        // that started it to see that it finished.
        everyMs: Number(process.env.POLARIS_DRIVE_JOBS_PRUNE_MS) || 24 * HOUR,
        leaseMs: null,
        run: pruneDriveJobs
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
        key: "mail-sync",
        // Every minute, but a mailbox is only asked when its own interval has
        // passed - the default is five minutes and its owner can set it lower.
        // The job running often is what makes that setting mean anything.
        everyMs: Number(process.env.POLARIS_MAIL_SYNC_MS) || MINUTE,
        // Leased. Two passes over the same mailbox at once is two IMAP sessions
        // per account, which is how a client gets rate limited by Gmail.
        leaseMs: 10 * MINUTE,
        run: syncMailboxes
    },
    {
        key: "mail-server",
        // The mail servers Polaris runs: whether each still answers, and the
        // DMARC reports that arrived in its report mailbox since the last pass.
        // Receivers send those daily, so a quarter of an hour is prompt enough.
        everyMs: 15 * MINUTE,
        // Leased: two passes would read the same report mailbox at once. Does
        // nothing on a Polaris that has not installed the Mail server app.
        leaseMs: 20 * MINUTE,
        run: runMailServerPass
    },
    {
        key: "mail-categories",
        // Every minute while there is a backlog, and free once there is not:
        // the pass looks for messages with no category and stops finding any.
        everyMs: MINUTE,
        // Leased, because two passes would decide the same batch twice.
        leaseMs: 5 * MINUTE,
        run: async () => {
            const sorted = await backfillCategories();
            const cleared = await sweepExpiredCodes();
            return { sorted, cleared };
        }
    },
    {
        key: "mail-send",
        // The safety net under the in-process timer, for anything a restart
        // dropped. A message queued a moment before a deploy goes late rather
        // than never.
        everyMs: Number(process.env.POLARIS_MAIL_SEND_MS) || MINUTE,
        // Leased, because sending twice is the one thing this must not do.
        leaseMs: 5 * MINUTE,
        run: sweepDueSends
    },
    {
        key: "mail-snooze",
        // A snooze is set to an hour, so a pass every five minutes is already
        // finer than anybody chooses.
        everyMs: 5 * MINUTE,
        // Unleased: waking a message twice is setting the same column to null
        // twice.
        leaseMs: null,
        run: wakeSnoozed
    },
    {
        key: "mail-uploads",
        // Files somebody attached in a composer they then closed. Nothing is
        // waiting on this.
        everyMs: HOUR,
        leaseMs: null,
        run: sweepOrphanUploads
    },
    {
        key: "service-crons",
        // Every minute, because a cron's finest grain is the minute. Not leased:
        // each firing is claimed by a compare-and-swap on the job's own row, so
        // two processes cannot both start the same one, and a lease here would
        // hold every job hostage to the slowest.
        everyMs: MINUTE,
        leaseMs: null,
        run: tickServiceCrons
    },
    {
        key: "service-autoscale",
        // Every minute: the decision counts consecutive readings, and a minute is
        // the grain its thresholds are written in. Leased, so two processes never
        // read the same streak and both add a replica.
        everyMs: MINUTE,
        leaseMs: 5 * MINUTE,
        run: () => runAutoscale()
    },
    {
        key: "service-sleep",
        // Every fifteen seconds: this is also what wakes a sleeping service, and the
        // visitor is looking at the waking page for as long as it takes. A pass with
        // no service that sleeps reads nothing.
        everyMs: 15_000,
        // Leased, so two processes never both stop or start the same container.
        leaseMs: 2 * MINUTE,
        run: () => runSleepPass()
    },
    {
        key: "service-desired-state",
        // Every five minutes. A service somebody stopped is stopped for good, so
        // this is only ever repairing the rare stop whose container half failed -
        // and the machine is asked once per target, about services that are
        // believed to be down and usually are.
        everyMs: 5 * MINUTE,
        // Leased, so two processes never both stop the same container.
        leaseMs: 10 * MINUTE,
        run: () => runDesiredStatePass()
    },
    {
        key: "update-scan",
        // Half-hourly: a registry is asked once per image and tag and GitHub once
        // per repository service, and nothing published is urgent to the minute.
        // Unleased: two passes write the same answer.
        everyMs: 30 * MINUTE,
        leaseMs: null,
        run: () => scanServiceUpdates()
    },
    {
        key: "runtime-logs",
        // Every minute. What a service printed is kept by reading its tail and
        // storing what is new, so the gap between passes is the most a service
        // can print before the middle of it is lost, and a minute is what keeps
        // that gap to a tail's worth for anything but a flood.
        everyMs: Number(process.env.POLARIS_RUNTIME_LOG_CAPTURE_MS) || MINUTE,
        // Leased: each pass reads the newest line kept and stores what follows
        // it, so two passes at once would both store the same lines.
        leaseMs: 5 * MINUTE,
        run: captureRuntimeLogs
    },
    {
        key: "runtime-logs-prune",
        // Hourly. The bounds are a week and a count per service, and a pass that
        // runs an hour late removes the same lines.
        everyMs: Number(process.env.POLARIS_RUNTIME_LOG_PRUNE_MS) || HOUR,
        // Unleased: two runners delete the same lines and one of them counts
        // zero.
        leaseMs: null,
        run: async () => ({ removed: await pruneRuntimeLogs() })
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
        key: "private-networks",
        // Ten minutes. An update recreates the edge without its attachments to the
        // private networks, and until this runs a service with its port closed in
        // an isolated environment is routed but not reached; the first pass after
        // boot is the one that matters, and the rest catch anything since.
        everyMs: Number(process.env.POLARIS_PRIVATE_NETWORKS_MS) || 10 * MINUTE,
        // Unleased: attaching what is already attached and removing what is
        // already gone are both no-ops, so a second runner changes nothing.
        leaseMs: null,
        run: reconcilePrivateNetworks
    },
    {
        key: "managed-certificates",
        // A quarter of an hour. A pass with nothing due reads a few rows and
        // writes nothing a server has not already got, and a domain proven or a
        // token saved on a screen is picked up on this cadence if the pass that
        // screen started was already running.
        everyMs: Number(process.env.POLARIS_MANAGED_CERTS_MS) || 15 * MINUTE,
        // Unleased here because the pass takes its own lease: a screen starts one
        // as well, and both must hold the same one.
        leaseMs: null,
        run: ensureManagedCertificates
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
    },
    {
        key: "database-upgrades",
        // A minute, because a maintenance window is picked to the minute.
        everyMs: MINUTE,
        // Unleased: each upgrade is claimed by moving its row out of "scheduled",
        // so a second runner finds nothing left to start.
        leaseMs: null,
        run: async () => (await import("@/lib/database-ops/upgrade")).sweepDueUpgrades()
    },
    {
        key: "database-archives",
        // Hourly: a base backup is taken for each archiving instance once its
        // newest is a day old, so an instance whose day comes round mid-hour
        // waits at most an hour, and the log keeps it recoverable meanwhile.
        everyMs: HOUR,
        // Leased past the gap: a base backup of a large instance takes a while,
        // and two runners would take two.
        leaseMs: 3 * HOUR,
        run: async () => (await import("@/lib/database-ops/pitr")).sweepArchives()
    },
    {
        key: "billing-budgets",
        // Hourly: the figures a budget is measured against are folded by the
        // hour, so a pass more often would read the same spend again.
        everyMs: HOUR,
        // Leased, because the pass tells people something: two runners would
        // each find the same threshold crossed and each tell everybody.
        leaseMs: 2 * HOUR,
        run: async () => (await import("@/lib/billing/budgets")).sweepBudgets()
    },
    {
        key: "object-replication",
        // Five minutes: how long a bucket replication can be down after its
        // store's container was recreated before it is started again.
        everyMs: 5 * MINUTE,
        // Leased: two runners checking the same process at once could both find
        // it stopped and start two.
        leaseMs: 10 * MINUTE,
        run: async () => (await import("@/lib/object-storage/store")).sweepReplications()
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
