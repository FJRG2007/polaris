/**
 * Which of a service's release containers on a machine are not the ones it runs
 * now, read from the labels the engine put on them rather than from a name worked
 * out again.
 *
 * Every release of a service runs in a compose project (or swarm stack) named
 * `polaris-<8 hex of the service id>`, with a release marker after it for a
 * release that runs in a project of its own. The project a deploy replaced used
 * to be derived again from its deployment row and taken down by that name, with
 * the compose file the daemon kept for it - so a release created under a shape
 * the row no longer describes, or one whose file no longer names its container,
 * kept running after its row said it was gone. The label is what the engine
 * itself groups the containers by, so reading it finds every release whatever
 * shape it was created under.
 *
 * Everything here is pure, so the one decision that removes something is the
 * tested part. It only ever names a container whose project is exactly the shape
 * Polaris gives a service's release and whose service is one it was asked about,
 * never one in a project it was told to keep. Volumes are not here at all.
 */

/** The compose label every container compose starts carries. */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** The label every container a swarm stack starts carries. */
export const STACK_NAMESPACE_LABEL = "com.docker.stack.namespace";

/** The shape of a service release's project: `polaris-<8 hex>`, optionally with
 *  a release marker. Tunnels (`polaris-qtunnel-...`), databases (`polaris-db-...`)
 *  and Polaris's own stack all fail it on purpose. */
const RELEASE_PROJECT = /^(polaris-[0-9a-f]{8})(?:-([a-z0-9]{1,8}))?$/;

/** One container that belongs to a service release, as the engine labels it. */
export interface ReleaseContainer {
    readonly id: string;
    readonly name: string;
    /** The compose project or swarm stack it was started in. */
    readonly project: string;
    /** `stack` for a swarm task, which only goes away with its stack. */
    readonly engine: "compose" | "stack";
    readonly running: boolean;
    /** When it was created, epoch milliseconds, or null when the engine did not say. */
    readonly createdAt: number | null;
}

/** The service project a release project belongs to, or null when it is not
 *  the shape of one. */
export function releaseBase(project: string | null | undefined): string | null {
    if (!project) return null;
    return RELEASE_PROJECT.exec(project)?.[1] ?? null;
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The engine's container listing (`GET /containers/json?all=1`), reduced to the
 * containers that belong to a service release. Anything without a release-shaped
 * project label is dropped here, so nothing an operator started can reach a removal.
 */
export function releaseContainersIn(listing: readonly unknown[]): ReleaseContainer[] {
    const out: ReleaseContainer[] = [];
    for (const raw of listing) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as {
            Id?: unknown;
            Names?: unknown;
            State?: unknown;
            Created?: unknown;
            Labels?: Record<string, unknown> | null;
        };
        const id = text(entry.Id);
        if (!id) continue;
        const compose = text(entry.Labels?.[COMPOSE_PROJECT_LABEL]);
        const stack = text(entry.Labels?.[STACK_NAMESPACE_LABEL]);
        const project = compose ?? stack;
        if (!releaseBase(project)) continue;
        const names = Array.isArray(entry.Names) ? entry.Names : [];
        out.push({
            id,
            name: text(names[0])?.replace(/^\//, "") ?? id.slice(0, 12),
            project: project as string,
            engine: compose ? "compose" : "stack",
            running: entry.State === "running",
            createdAt:
                typeof entry.Created === "number" && Number.isFinite(entry.Created)
                    ? entry.Created * 1000
                    : null
        });
    }
    return out;
}

/** The `docker ps --format` template `releaseContainersFromPs` reads: one
 *  container a line, tab-separated. Labels are asked for one by one, because the
 *  joined `.Labels` string cannot be split - a router rule has commas in it. */
export const RELEASE_PS_FORMAT = `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "${COMPOSE_PROJECT_LABEL}"}}\t{{.Label "${STACK_NAMESPACE_LABEL}"}}\t{{.CreatedAt}}`;

/** `docker ps`'s creation time (`2026-08-20 10:11:12 +0000 UTC`) as epoch ms. */
function psCreatedAt(value: string | undefined): number | null {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(value ?? "");
    if (!match) return null;
    const at = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
    return Number.isFinite(at) ? at : null;
}

/** What `docker ps -a --format RELEASE_PS_FORMAT` printed, as release containers.
 *  The same filter as `releaseContainersIn`. */
export function releaseContainersFromPs(output: string): ReleaseContainer[] {
    const listing: unknown[] = [];
    for (const line of output.split("\n")) {
        const [id, name, state, compose, stack, created] = line.replace(/\r$/, "").split("\t");
        if (!id) continue;
        const at = psCreatedAt(created);
        listing.push({
            Id: id,
            Names: name ? [name] : [],
            State: state,
            Created: at === null ? undefined : at / 1000,
            Labels: {
                ...(compose ? { [COMPOSE_PROJECT_LABEL]: compose } : {}),
                ...(stack ? { [STACK_NAMESPACE_LABEL]: stack } : {})
            }
        });
    }
    return releaseContainersIn(listing);
}

/**
 * The containers of one service that are in none of the projects it keeps: what a
 * promotion leaves behind once the edge dials the new release. `base` is the
 * service's own project (`polaris-<hash>`); `keep` holds every project that must
 * stay - the one serving, and any release still on record as running.
 */
export function supersededContainers(
    containers: readonly ReleaseContainer[],
    base: string,
    keep: ReadonlySet<string>
): ReleaseContainer[] {
    return containers.filter(
        (container) => releaseBase(container.project) === base && !keep.has(container.project)
    );
}

/**
 * Every release container on a machine that is not one its service still runs, for
 * the periodic sweep.
 *
 * `services` maps each service project Polaris holds on this machine to the
 * projects that service keeps. A container whose service is not in the map is left
 * alone - a service that is mid-deploy, has no current release, runs elsewhere, or
 * was removed (that is the leftovers screen's business) is not this sweep's to
 * judge. A container younger than `graceMs` is left alone too: it may belong to a
 * deploy that began after the records were read.
 */
export function orphanedReleaseContainers(
    containers: readonly ReleaseContainer[],
    services: ReadonlyMap<string, ReadonlySet<string>>,
    now: number,
    graceMs: number
): ReleaseContainer[] {
    return containers.filter((container) => {
        const base = releaseBase(container.project);
        const keep = base ? services.get(base) : undefined;
        if (!keep || keep.has(container.project)) return false;
        return container.createdAt !== null && now - container.createdAt >= graceMs;
    });
}

/**
 * How to take a set of release containers away: compose containers one by one, a
 * swarm task only with its whole stack (the engine starts a removed task again).
 */
export function removalPlan(containers: readonly ReleaseContainer[]): {
    readonly containers: readonly ReleaseContainer[];
    readonly stacks: readonly string[];
} {
    return {
        containers: containers.filter((container) => container.engine === "compose"),
        stacks: [
            ...new Set(
                containers
                    .filter((container) => container.engine === "stack")
                    .map((container) => container.project)
            )
        ].sort()
    };
}
