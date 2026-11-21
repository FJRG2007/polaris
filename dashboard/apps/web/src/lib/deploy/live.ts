/**
 * Telling an open project page that one of its services changed state.
 *
 * A redeploy or a restart pressed on a Stream Deck goes through the assistant's
 * tool; a build finishes in the background; a schedule stops a service; another
 * tab rolls one back. A deployment's status alone is written from some
 * twenty-five places, so rather than each of them remembering to say so, every
 * write to the tables a service card is drawn from is heard where it lands - the
 * database hook the live access channel uses (`onModelWrite`) - and resolved to
 * the project it belongs to here. A restart, which writes nothing, says so
 * itself (`deployServicesChanged`).
 *
 * What travels is only a project id. The page answers a frame by reading itself
 * again through the same session and checks it always does, so a frame can
 * never hand anybody a row; the stream checks the reader's access to the
 * project before it opens.
 *
 * Built for many open pages at once: nothing is subscribed until the first
 * stream opens, the writes of one burst are gathered and resolved to projects
 * in at most three bounded reads for the whole process - never a read per
 * write, nor per open page - and each stream coalesces its own frames again.
 *
 * The hook fires when a write's query returns, which inside an interactive
 * `$transaction` is before the commit. Nothing is read here in that tick: a
 * burst is resolved `GATHER_MS` later, the stream waits again before its frame,
 * and the page reads after that - and no write this listens for runs inside a
 * transaction today (the one transactional Application write, the public
 * networking config, changes no column in `SHOWN`). Should one ever land in a
 * long transaction, the page's poll is still there to catch what the early
 * frame read too soon.
 *
 * Held on globalThis rather than in a module binding, because a dev server
 * re-evaluates a module on edit and the bundle may hold more than one copy, and
 * either would strand every open stream on a set nobody writes to. Best effort:
 * nothing that writes may fail because telling a page about it did.
 * Server-only.
 */

import { onModelWrite, prisma, type ModelWrite } from "@polaris/db";

/** Which project moved; null when a write named no service, so it could be any. */
type Listener = (projectId: string | null) => void;

/** The tables a service card's state is drawn from. */
const WATCHED = ["Deployment", "Application", "ManagedDatabase"] as const;

/** The columns whose change a card shows. Any other write - a log path, a
 *  health check's timestamp - is not worth a redraw of every open page. */
const SHOWN: Record<(typeof WATCHED)[number], readonly string[]> = {
    Deployment: ["status", "finishedAt", "startedAt", "pinned", "imageKept", "replicas"],
    Application: ["desiredState", "asleepSince", "currentDeploymentId", "replicas", "name", "binnedAt"],
    ManagedDatabase: ["status", "desiredState", "name", "binnedAt"]
};

/** Rows and kinds always count: a deployment created or removed is news. */
const STRUCTURAL = new Set(["create", "createMany", "createManyAndReturn", "delete", "deleteMany"]);

/** How long the writes of one burst are gathered before they are resolved. */
const GATHER_MS = 100;

/** More ids than this in one burst is a sweep: every open page is woken rather
 *  than the burst resolved row by row. */
const MAX_IDS = 500;

interface Pending {
    deploymentIds: Set<string>;
    serviceIds: Set<string>;
    anybody: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}

interface Registry {
    listeners: Set<Listener>;
    unsubscribe: (() => void) | null;
    pending: Pending;
}

const REGISTRY = Symbol.for("polaris.deploy.live");

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    holder[REGISTRY] ??= {
        listeners: new Set(),
        unsubscribe: null,
        pending: {
            deploymentIds: new Set(),
            serviceIds: new Set(),
            anybody: false,
            timer: null
        }
    };
    return holder[REGISTRY];
}

/** The ids a `where` or a `data` names under `key`: one, an `in` list, or none. */
function idsAt(value: unknown, key: string): string[] {
    if (!value || typeof value !== "object") return [];
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string") return [field];
    if (field && typeof field === "object") {
        const list = (field as { in?: unknown }).in;
        if (Array.isArray(list)) return list.filter((id): id is string => typeof id === "string");
    }
    return [];
}

/** True when the write changes something a card shows. */
function shown(write: ModelWrite): boolean {
    if (STRUCTURAL.has(write.operation)) return true;
    const args = (write.args ?? {}) as { data?: unknown; update?: unknown; create?: unknown };
    const columns = SHOWN[write.model as (typeof WATCHED)[number]] ?? [];
    return [args.data, args.update, args.create].some(
        (data) =>
            !!data &&
            typeof data === "object" &&
            columns.some((column) => column in (data as Record<string, unknown>))
    );
}

/** Note what a write names, to be resolved with the rest of its burst. */
function gather(write: ModelWrite): void {
    const held = registry();
    if (held.listeners.size === 0 || !shown(write)) return;
    const args = (write.args ?? {}) as { where?: unknown; data?: unknown; create?: unknown };
    const rows = Array.isArray(args.data) ? args.data : [args.data, args.create];
    const pending = held.pending;
    const deployments =
        write.model === "Deployment" ? idsAt(args.where, "id") : [];
    const services =
        write.model === "Deployment"
            ? [
                  ...idsAt(args.where, "deployableId"),
                  ...rows.flatMap((row) => idsAt(row, "deployableId"))
              ]
            : [
                  ...idsAt(args.where, "id"),
                  // A new service: its environment is what places it.
                  ...rows.flatMap((row) => idsAt(row, "environmentId"))
              ];
    for (const id of deployments) pending.deploymentIds.add(id);
    for (const id of services) pending.serviceIds.add(id);
    if (deployments.length + services.length === 0) pending.anybody = true;
    schedule();
}

function schedule(): void {
    const pending = registry().pending;
    if (pending.timer) return;
    pending.timer = setTimeout(() => {
        pending.timer = null;
        void flush().catch((caught: unknown) => console.error("deploy: live flush failed", caught));
    }, GATHER_MS);
}

/** Resolve one burst to the projects it touched and tell every listener. */
async function flush(): Promise<void> {
    const held = registry();
    const pending = held.pending;
    const deploymentIds = [...pending.deploymentIds];
    const serviceIds = new Set(pending.serviceIds);
    const projectIds = new Set<string>();
    let anybody = pending.anybody;
    pending.deploymentIds.clear();
    pending.serviceIds.clear();
    pending.anybody = false;
    if (held.listeners.size === 0) return;

    if (deploymentIds.length + serviceIds.size > MAX_IDS) anybody = true;
    else {
        if (deploymentIds.length > 0) {
            const rows = await prisma.deployment.findMany({
                where: { id: { in: deploymentIds } },
                select: { deployableId: true }
            });
            for (const row of rows) serviceIds.add(row.deployableId);
        }
        if (serviceIds.size > 0) {
            const ids = [...serviceIds];
            const [apps, databases, environments] = await Promise.all([
                prisma.application.findMany({
                    where: { id: { in: ids } },
                    select: { environment: { select: { projectId: true } } }
                }),
                prisma.managedDatabase.findMany({
                    where: { id: { in: ids } },
                    select: { environment: { select: { projectId: true } } }
                }),
                prisma.environment.findMany({
                    where: { id: { in: ids } },
                    select: { projectId: true }
                })
            ]);
            for (const row of [...apps, ...databases]) projectIds.add(row.environment.projectId);
            for (const row of environments) projectIds.add(row.projectId);
        }
    }
    const targets: (string | null)[] = anybody ? [null] : [...projectIds];
    for (const target of targets)
        for (const listener of held.listeners) {
            try {
                listener(target);
            } catch (caught) {
                console.error("deploy: a live listener failed", caught);
            }
        }
}

/**
 * Announce that these services changed state without writing anything a hook
 * would hear - a container restarted in place. Never throws.
 */
export function deployServicesChanged(serviceIds: readonly string[]): void {
    try {
        const held = registry();
        if (held.listeners.size === 0) return;
        for (const id of serviceIds) held.pending.serviceIds.add(id);
        schedule();
    } catch (caught) {
        console.error("deploy: a live announcement failed", caught);
    }
}

/**
 * Hear which projects' services changed until the returned function is called.
 * The database hook is subscribed with the first listener and released with
 * the last, so a server with no project page open does no work at all.
 */
export function onDeployChanged(listener: Listener): () => void {
    const held = registry();
    held.listeners.add(listener);
    if (!held.unsubscribe) held.unsubscribe = onModelWrite(WATCHED, gather);
    return () => {
        held.listeners.delete(listener);
        if (held.listeners.size > 0 || !held.unsubscribe) return;
        held.unsubscribe();
        held.unsubscribe = null;
    };
}
