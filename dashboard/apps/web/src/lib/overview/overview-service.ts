/**
 * What the Overview cards are filled with.
 *
 * One read per card, and only for the cards actually on somebody's grid: the
 * screen asks for the ids it is drawing, so a reader who turned Storage off never
 * pays for a device listing, and a reader with no deploy access never touches the
 * metric tables. Each block is guarded by the same permission the card's own
 * screen requires, resolved here rather than trusted from the request.
 *
 * Nothing on this page is worth a failed navigation, so a card whose source
 * throws comes back as `null` and the grid says that card could not be read while
 * the rest of the screen stands. This is deliberately the only place in the app
 * where a swallowed error is the right answer - the alternative is one unreachable
 * NAS taking down the screen everybody lands on.
 */

import { prisma } from "@polaris/db";
import { INSTALLED_BASE } from "@/lib/apps";
import { sessionCanAny } from "@/lib/session";
import { shelfScope } from "@/lib/tasks/access";
import type { SessionUser } from "@/lib/session";
import { listProjects } from "@/lib/deploy-service";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import type { OverviewWidgetId } from "@polaris/core";
import { listUserActivity } from "@/lib/audit-service";
import { listUserSessions } from "@/lib/session-directory";
import { listRecentAlarmEvents } from "@/lib/watch-service";
import type { MyWorkTask } from "@/lib/tasks/report-service";
import type { MetricSubjectType } from "@/lib/metrics-shared";
import { listGameServerFacts } from "@/lib/apps/games-service";
import { getWatchOverview } from "@/lib/watch-overview-service";
import { myUrgentTasks, myWorkCounts } from "@/lib/tasks/report-service";
import { HOST_CONNECTION_PREFIX, listAccessibleConnections } from "@/lib/storage-service";

/** Rows shown inside one card before it defers to its own screen. A card that
 *  scrolls is a screen somebody put on a grid. */
const CARD_ROWS = 5;

/** One line of a card: something with a state, and somewhere to go. */
export interface OverviewRow {
    id: string;
    label: string;
    /** Second line: where it lives, or what it is. */
    detail: string;
    /** up | down | idle - a dot, not a percentage. */
    state: "up" | "down" | "idle";
    stateLabel: string;
    href: string;
}

export interface OverviewServices {
    rows: OverviewRow[];
    running: number;
    total: number;
    /** Projects behind those services, for the line under the count. */
    projects: number;
}

export interface OverviewUsageEntry {
    id: string;
    name: string;
    cpuPercent: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    /** CPU over the last hour, as plain numbers for a sparkline. */
    spark: (number | null)[];
    href: string;
}

export interface OverviewAlarmEvent {
    id: string;
    name: string;
    kind: string;
    detail: string | null;
    createdAt: string;
}

export interface OverviewAlarms {
    firing: number;
    events: OverviewAlarmEvent[];
}

export interface OverviewTasks {
    assigned: number;
    overdue: number;
    dueToday: number;
    /** The work itself, most pressing first. Counts alone say how much there is
     *  and nothing about what it is, which is not a reason to open anything. */
    rows: MyWorkTask[];
}

export interface OverviewStorageEntry {
    id: string;
    name: string;
    usedBytes: number | null;
    totalBytes: number | null;
    href: string;
}

export interface OverviewSessionEntry {
    id: string;
    /** The device as it described itself, already humanized. */
    device: string;
    /** Where from: the address, and the country when one was resolved. */
    where: string;
    /** True for the session reading this screen. */
    current: boolean;
    lastSeenAt: string;
}

export interface OverviewSessions {
    /** Every live session, of which `entries` is the newest handful. */
    total: number;
    entries: OverviewSessionEntry[];
}

export interface OverviewGameServer {
    id: string;
    name: string;
    /** The game it plays and the machine it runs on, as one line. */
    detail: string;
    running: boolean;
    /** How many players it was built for, null when the install never said. */
    slots: number | null;
    href: string;
}

export interface OverviewGames {
    running: number;
    total: number;
    servers: OverviewGameServer[];
}

export interface OverviewActivityEntry {
    id: string;
    /** The action as recorded ("session.revoked"), for the screen to label. */
    action: string;
    /** What it was aimed at, or "" when it named nothing. */
    target: string;
    at: string;
}

/** Every card's data, each key absent when the card was not asked for and null
 *  when its source could not be read. */
export interface OverviewData {
    services?: OverviewServices | null;
    usage?: OverviewUsageEntry[] | null;
    alarms?: OverviewAlarms | null;
    tasks?: OverviewTasks | null;
    storage?: OverviewStorageEntry[] | null;
    sessions?: OverviewSessions | null;
    activity?: OverviewActivityEntry[] | null;
    games?: OverviewGames | null;
}

/** The cards that are read here at all. The rest (pinned links, this browser's
 *  history, the notification feed, the launcher) are answered in the browser. */
const SERVER_WIDGETS = [
    "services",
    "usage",
    "alarms",
    "tasks",
    "storage",
    "sessions",
    "activity",
    "games"
] as const;

type ServerWidgetId = (typeof SERVER_WIDGETS)[number];

export function isServerOverviewWidget(id: OverviewWidgetId): id is ServerWidgetId {
    return (SERVER_WIDGETS as readonly string[]).includes(id);
}

/** Run one card's read, turning a failure into "this card could not be read"
 *  rather than a failed page. */
async function card<T>(load: () => Promise<T>): Promise<T | null> {
    try {
        return await load();
    } catch (caught) {
        console.error(caught);
        return null;
    }
}

export async function getOverviewData(user: SessionUser, wanted: readonly OverviewWidgetId[]): Promise<OverviewData> {
    const asked = new Set(wanted.filter(isServerOverviewWidget));
    if (asked.size === 0) return {};

    const [canDeploy, canTasks, canDrive, canGames] = await Promise.all([
        asked.has("services") || asked.has("usage") || asked.has("alarms")
            ? sessionCanAny(user, "deploy.read")
            : Promise.resolve(false),
        asked.has("tasks") ? sessionCanAny(user, "tasks.read") : Promise.resolve(false),
        asked.has("storage") ? sessionCanAny(user, "drive.read") : Promise.resolve(false),
        asked.has("games") ? sessionCanAny(user, "games.read") : Promise.resolve(false)
    ]);

    // Services, usage and alarms all come out of the same monitoring read, so
    // three cards cost one pass rather than three.
    const watch = canDeploy && (asked.has("usage") || asked.has("alarms")) ? card(() => getWatchOverview(user.id)) : null;

    const [services, monitoring, events, tasks, storage, sessions, activity, games] = await Promise.all([
        asked.has("services") && canDeploy ? card(() => deployedServices(user)) : Promise.resolve(undefined),
        watch ?? Promise.resolve(undefined),
        asked.has("alarms") && canDeploy ? card(() => listRecentAlarmEvents(user.id, CARD_ROWS)) : Promise.resolve(undefined),
        asked.has("tasks") && canTasks ? card(() => assignedWork(user)) : Promise.resolve(undefined),
        asked.has("storage") && canDrive ? card(() => storageUsage(user.id)) : Promise.resolve(undefined),
        // The account's own two, which ask for no permission: everybody may read
        // where their account is open and what was done with it.
        asked.has("sessions") ? card(() => openSessions(user)) : Promise.resolve(undefined),
        asked.has("activity") ? card(() => recentActivity(user.id)) : Promise.resolve(undefined),
        asked.has("games") && canGames ? card(() => gameServers(user.id)) : Promise.resolve(undefined)
    ]);

    const data: OverviewData = {};
    if (asked.has("services")) data.services = canDeploy ? (services ?? null) : null;
    if (asked.has("usage")) {
        data.usage = canDeploy
            ? (monitoring?.servers.slice(0, CARD_ROWS).map((server) => ({
                  id: server.id,
                  name: server.name,
                  cpuPercent: server.cpuPercent,
                  memUsedBytes: server.memUsedBytes,
                  memTotalBytes: server.memTotalBytes,
                  spark: server.spark.map((point) => point.v),
                  href: server.href
              })) ?? null)
            : null;
    }
    if (asked.has("alarms")) {
        data.alarms =
            canDeploy && monitoring && events
                ? {
                      firing: monitoring.firing,
                      events: events.map((event) => ({
                          id: event.id,
                          name: event.alarmName,
                          kind: event.kind,
                          detail: event.detail,
                          createdAt: event.createdAt
                      }))
                  }
                : null;
    }
    if (asked.has("tasks")) data.tasks = canTasks ? (tasks ?? null) : null;
    if (asked.has("storage")) data.storage = canDrive ? (storage ?? null) : null;
    if (asked.has("sessions")) data.sessions = sessions ?? null;
    if (asked.has("activity")) data.activity = activity ?? null;
    if (asked.has("games")) data.games = canGames ? (games ?? null) : null;
    return data;
}

/**
 * The game servers this account runs or was given, and how many are up.
 *
 * Read from the install records rather than by asking each container who is on
 * it: presence costs a command inside every running server, which is what the
 * game screens spend and what a landing screen must not. "Up" here therefore
 * means the server is meant to be running, and the card links to the screen that
 * knows whether anybody is actually playing.
 */
async function gameServers(userId: string): Promise<OverviewGames> {
    const servers = await listGameServerFacts(userId);
    const rows = servers.map((server) => ({
        id: server.id,
        name: server.name,
        detail: [server.catalogName, server.serverName].filter(Boolean).join(" - "),
        running: server.running,
        slots: server.slots,
        href: `${INSTALLED_BASE}/${server.id}`
    }));
    return {
        running: rows.filter((row) => row.running).length,
        total: rows.length,
        // Running first, like the services card and for the same reason: the
        // servers somebody can actually join are the list, and the count above it
        // is what says how many are not.
        servers: [...rows]
            .sort((left, right) => Number(right.running) - Number(left.running) || left.name.localeCompare(right.name))
            .slice(0, CARD_ROWS)
    };
}

/**
 * Where this account is open right now.
 *
 * Read for the account making the request and no other, so the card is the same
 * list as its own sessions screen rather than a view onto anybody else's. The
 * session reading the screen is marked rather than hidden: "and this one" is what
 * turns a list of devices into a list somebody can act on.
 */
async function openSessions(user: SessionUser): Promise<OverviewSessions> {
    const sessions = await listUserSessions(user.id, user.sessionId);
    return {
        total: sessions.length,
        entries: sessions.slice(0, CARD_ROWS).map((session) => ({
            id: session.id,
            device: session.device,
            where: [session.ip, session.country].filter(Boolean).join(" - "),
            current: session.current,
            lastSeenAt: session.lastSeenAt
        }))
    };
}

/** What was done with this account lately, newest first. */
async function recentActivity(userId: string): Promise<OverviewActivityEntry[]> {
    const entries = await listUserActivity(userId, { limit: CARD_ROWS });
    return entries.map((entry) => ({ id: entry.id, action: entry.action, target: entry.target, at: entry.at }));
}

/**
 * The deploy applications that are really something else wearing a container.
 *
 * An installed app - a game server, anything from the catalogue - is backed by a
 * Deploy application, so it is deployed in the literal sense and would be counted
 * and listed as a service on top of appearing on its own card and its own screen.
 * One thing, in two lists, under two names. It belongs to whatever installed it,
 * and Services is left saying what somebody deployed themselves.
 */
async function managedApplicationIds(ownerId: string): Promise<Set<string>> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true }
    });
    return new Set(installs.map((install) => install.applicationId!).filter(Boolean));
}

/**
 * What is deployed, and how much of it is up.
 *
 * Read from the deploy records rather than by asking every daemon what it is
 * running: the landing screen answers "is anything down" and it must not cost a
 * round trip per machine to do it. A service is up when it has a deployment
 * behind it and is meant to be running; one that was deliberately stopped is
 * idle rather than broken, which is a distinction the count has to keep or every
 * stopped service reads as an outage.
 */
async function deployedServices(user: SessionUser): Promise<OverviewServices> {
    const [projects, managed] = await Promise.all([
        listProjects(user.id, await scopeOrgIdFor(user.id)),
        managedApplicationIds(user.id)
    ]);
    const rows: OverviewRow[] = [];
    let running = 0;
    let total = 0;

    for (const project of projects) {
        for (const environment of project.environments) {
            for (const application of environment.applications) {
                if (managed.has(application.id)) continue;
                total += 1;
                const stopped = application.desiredState !== "running";
                const up = !stopped && Boolean(application.currentDeploymentId);
                if (up) running += 1;
                rows.push({
                    id: application.id,
                    label: application.name,
                    detail: `${project.name} / ${environment.name}`,
                    state: up ? "up" : stopped ? "idle" : "down",
                    stateLabel: up ? "Running" : stopped ? "Stopped" : "Not deployed",
                    href: `/apps/deploy/${project.id}`
                });
            }
        }
    }

    // What is actually running first - it is what somebody came to the card to
    // see, and a list headed by things that are switched off reads as an outage.
    // Then what is wrong, then what was stopped on purpose, which is the one state
    // nobody needs to be told about twice. With more services than the card holds
    // a stopped one can fall off the end; the count above the list is what says so,
    // and it turns amber the moment the two numbers differ.
    const rank = { up: 0, down: 1, idle: 2 } as const;
    rows.sort((left, right) => rank[left.state] - rank[right.state] || left.label.localeCompare(right.label));
    return { rows: rows.slice(0, CARD_ROWS), running, total, projects: projects.length };
}

async function assignedWork(user: SessionUser): Promise<OverviewTasks> {
    const scope = await shelfScope({ id: user.id, isAdmin: user.isAdmin });
    const [counts, rows] = await Promise.all([
        myWorkCounts(user.id, scope),
        myUrgentTasks(user.id, scope, CARD_ROWS)
    ]);
    return { ...counts, rows };
}

/**
 * How full each connected device is, from the samples the collector already
 * takes. Never by asking the devices: a NAS that has gone to sleep would hold
 * the card open for its whole timeout, and the collector's last reading is the
 * same number a minute older.
 */
async function storageUsage(userId: string): Promise<OverviewStorageEntry[]> {
    const connections = (await listAccessibleConnections(userId)).filter(
        (connection) => !connection.id.startsWith(HOST_CONNECTION_PREFIX)
    );
    if (connections.length === 0) return [];

    const samples = await latestSamples(
        "storage",
        connections.map((connection) => connection.id)
    );
    return connections
        .map((connection) => {
            const sample = samples.get(connection.id);
            return {
                id: connection.id,
                name: connection.name,
                usedBytes: sample?.diskUsedBytes == null ? null : Number(sample.diskUsedBytes),
                totalBytes: sample?.diskTotalBytes == null ? null : Number(sample.diskTotalBytes),
                href: `/drive/overview#${connection.id}`
            };
        })
        // A device that has never reported usage has nothing to draw, and a row of
        // dashes is not worth a line of the card.
        .filter((entry) => entry.usedBytes !== null || entry.totalBytes !== null)
        .sort((left, right) => usedRatio(right) - usedRatio(left))
        .slice(0, CARD_ROWS);
}

function usedRatio(entry: OverviewStorageEntry): number {
    if (!entry.usedBytes || !entry.totalBytes) return 0;
    return entry.usedBytes / entry.totalBytes;
}

/** The most recent sample for each of a set of subjects. */
async function latestSamples(
    subjectType: MetricSubjectType,
    subjectIds: readonly string[]
): Promise<Map<string, { diskUsedBytes: bigint | null; diskTotalBytes: bigint | null }>> {
    const found = new Map<string, { diskUsedBytes: bigint | null; diskTotalBytes: bigint | null }>();
    if (subjectIds.length === 0) return found;
    const rows = await prisma.metricSample.findMany({
        where: { subjectType, subjectId: { in: [...subjectIds] } },
        orderBy: { ts: "desc" },
        // One row per subject is what is wanted, and Prisma has no "latest per
        // group": a bounded window of the newest rows across all of them, then
        // first-seen wins, costs one indexed read instead of one query each.
        take: subjectIds.length * 4,
        select: { subjectId: true, diskUsedBytes: true, diskTotalBytes: true }
    });
    for (const row of rows) {
        if (found.has(row.subjectId)) continue;
        found.set(row.subjectId, { diskUsedBytes: row.diskUsedBytes, diskTotalBytes: row.diskTotalBytes });
    }
    return found;
}
