/**
 * Whose container is this, and what does it add up to.
 *
 * Everything Polaris starts on the engine is started with compose, and the
 * project it is started under is the only thing that says what it belongs to -
 * names are chosen by the operator and change with every redeploy. So a container
 * is attributed by reading its project back to the record that produced it: a
 * service, a marketplace install (which is a service with an install row in front
 * of it), or a managed database.
 *
 * Kept apart from the measuring in `consumption-service` for the reason
 * `polaris-parts` is: this is the half that can be wrong quietly. A project read
 * as the wrong subject, or as no subject at all, does not fail - it moves a game
 * server's memory onto another app's row, or into "everything else", and the
 * screen goes on looking plausible. Pure, and there is a test that says which is
 * which.
 *
 * The rule is never "does it start with polaris-". Matching a subject means the
 * hash in its project resolves to a record that exists; a project nothing claims
 * is somebody else's container, whatever it is called.
 */

import { shortHash } from "@polaris/deploy";
import { isPolarisPart } from "@/lib/polaris-parts";
import type {
    ConsumptionGroup,
    ConsumptionGroupId,
    ConsumptionRow
} from "@/app/(app)/admin/consumption/types";

/** The kinds of record a compose project can belong to. */
export type SubjectKind = "application" | "database";

/** What a compose project says about the thing it was started for. */
export interface ProjectSubject {
    readonly kind: SubjectKind;
    /** The short hash of the record's id, which is what the project carries. */
    readonly hash: string;
    /** Whether the project is the subject itself, or a tunnel opened to publish
     *  it. A tunnel costs the app it publishes, and is counted there, but it is
     *  not what says the app is running. */
    readonly role: "self" | "tunnel";
}

/**
 * The hash a subject's compose projects are named after.
 *
 * One definition rather than five: the deploy pipeline, the three tunnel services
 * and the database provisioner each build their project from `shortHash(id, 8)`,
 * and reading them back has to use the same width. A hash taken at a different
 * length matches nothing and is silent about it.
 */
export function subjectHash(id: string): string {
    return shortHash(id, 8);
}

/**
 * The subject a compose project names, if it names one at all.
 *
 * `polaris-<hash>` is a service; `-<marker>` after it is one kept release of that
 * service, which belongs to it. `polaris-db-<hash>` is a managed database, and the
 * three tunnel prefixes are a door opened for the service whose hash they carry.
 */
export function projectSubject(project: string | null): ProjectSubject | null {
    const match = project ? /^polaris-(?:(db|qtunnel|ntunnel|ngrok)-)?([0-9a-f]{8})(?:-[a-z0-9-]+)?$/.exec(project) : null;
    if (!match) return null;
    const prefix = match[1];
    const hash = match[2] as string;
    if (prefix === "db") return { kind: "database", hash, role: "self" };
    if (prefix) return { kind: "application", hash, role: "tunnel" };
    return { kind: "application", hash, role: "self" };
}

/** What each group is, in the order the screen reads them. */
export const GROUPS: ReadonlyArray<{ id: ConsumptionGroupId; label: string; description: string }> = [
    {
        id: "polaris",
        label: "Polaris itself",
        description: "The control plane: the dashboard, the database, the edge, and the rest of the stack."
    },
    {
        id: "apps",
        label: "Marketplace apps",
        description: "Everything installed from the marketplace, game servers included."
    },
    {
        id: "services",
        label: "Deployed services",
        description: "Services and databases deployed here, with the releases and tunnels they keep."
    },
    {
        id: "other",
        label: "Everything else",
        description: "Containers on this machine that Polaris did not start."
    }
];

/** How a thing reads once something of it has been found. */
export interface ClaimBucket {
    readonly id: string;
    readonly name: string;
    readonly detail: string;
    readonly owner: string | null;
    readonly group: ConsumptionGroupId;
    readonly href: string | null;
}

/** One record a container can be traced back to, and the key its containers are
 *  gathered under. */
export interface Claim {
    readonly key: string;
    readonly bucket: ClaimBucket;
}

/** Everything the deployment has, keyed by the hash its compose projects carry. */
export interface ClaimIndex {
    readonly applications: ReadonlyMap<string, Claim>;
    readonly databases: ReadonlyMap<string, Claim>;
    /** Installs, keyed by their own bucket key, so one with no container on this
     *  machine can still be given a row. */
    readonly installs: ReadonlyMap<string, Claim>;
}

/** What attribution needs of a container: how the engine listed it, and whatever
 *  the sampler last read from it. */
export interface Attributable {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    readonly state: string;
    readonly composeProject: string | null;
    readonly composeService: string | null;
    /** Null for a container that is not running, and for one nothing has sampled
     *  yet - a figure of zero would read as an idle container rather than as an
     *  unknown one. */
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
}

/** One thing being added up, before it becomes a row. */
interface Bucket extends ClaimBucket {
    containers: number;
    /** Containers of any kind that are up, which is what the group's count is in
     *  terms of and what a bucket that is nothing but a tunnel reads from. */
    running: number;
    /** Containers that are the thing itself rather than a tunnel in front of it -
     *  a tunnel that is up says nothing about whether the app is. */
    self: number;
    selfRunning: number;
    cpuPercent: number | null;
    memUsedBytes: number | null;
}

/**
 * Add every container up into what it belongs to, and every thing into its group.
 *
 * @param connectionId The Containers host these came from, for the link on a row
 *                     that is only ever a container.
 */
export function attribute(
    containers: readonly Attributable[],
    index: ClaimIndex,
    connectionId: string
): ConsumptionGroup[] {
    const buckets = new Map<string, Bucket>();

    for (const container of containers) {
        const claim = claimFor(container, index, connectionId);
        const bucket = buckets.get(claim.key) ?? open(claim.bucket);
        buckets.set(claim.key, bucket);
        bucket.containers += 1;
        const running = container.state === "running";
        if (running) bucket.running += 1;
        if (projectSubject(container.composeProject)?.role !== "tunnel") {
            bucket.self += 1;
            if (running) bucket.selfRunning += 1;
        }
        if (container.cpuPercent !== null) {
            bucket.cpuPercent = round((bucket.cpuPercent ?? 0) + container.cpuPercent);
        }
        if (container.memUsedBytes !== null) {
            bucket.memUsedBytes = (bucket.memUsedBytes ?? 0) + container.memUsedBytes;
        }
    }

    // An install whose containers are not on this machine: it runs on a server
    // Polaris deploys to, and the row says so rather than disappearing. A
    // marketplace app that silently left the screen because it was placed
    // elsewhere is the failure worth avoiding.
    for (const [key, claim] of index.installs) {
        if (!buckets.has(key)) buckets.set(key, open(claim.bucket));
    }

    const all = [...buckets.values()];
    return GROUPS.map((group) => build(group, all));
}

function open(bucket: ClaimBucket): Bucket {
    return { ...bucket, containers: 0, running: 0, self: 0, selfRunning: 0, cpuPercent: null, memUsedBytes: null };
}

/** Which thing a container belongs to, and how that thing reads if it is the
 *  first anybody has seen of it. */
function claimFor(container: Attributable, index: ClaimIndex, connectionId: string): Claim {
    // Polaris first: its own projects are exact names and nothing else may claim
    // one. Every part of the stack lands in one bucket, since the screen reads the
    // part-by-part breakdown from the footprint endpoint instead.
    if (isPolarisPart(container)) {
        return {
            key: "polaris",
            bucket: {
                id: "polaris",
                name: "Polaris",
                detail: "The control plane and the tunnels publishing it",
                owner: null,
                group: "polaris",
                href: null
            }
        };
    }

    const subject = projectSubject(container.composeProject);
    const claimed = subject
        ? (subject.kind === "database" ? index.databases : index.applications).get(subject.hash)
        : undefined;
    if (claimed) return claimed;

    return {
        key: `container:${container.id}`,
        bucket: {
            id: container.id,
            name: container.name,
            detail: container.image,
            owner: null,
            group: "other",
            href: `/apps/containers/${encodeURIComponent(container.name)}?c=${encodeURIComponent(connectionId)}`
        }
    };
}

function build(
    group: { id: ConsumptionGroupId; label: string; description: string },
    buckets: readonly Bucket[]
): ConsumptionGroup {
    const mine = buckets.filter((bucket) => bucket.group === group.id);
    return {
        ...group,
        // Polaris is a total here and a table on its own endpoint, so it carries
        // no rows: one bucket holding the whole stack would be a table of one.
        rows: group.id === "polaris" ? [] : mine.map(toRow).sort(byWeight),
        containers: mine.reduce((total, bucket) => total + bucket.containers, 0),
        running: mine.reduce((total, bucket) => total + bucket.running, 0),
        cpuPercent: round(mine.reduce((total, bucket) => total + (bucket.cpuPercent ?? 0), 0)),
        memUsedBytes: mine.reduce((total, bucket) => total + (bucket.memUsedBytes ?? 0), 0)
    };
}

/** Heaviest first: the row somebody opened this screen to find is the one at the
 *  top of it. Memory rather than CPU, which is the figure that moves between two
 *  reads of the same idle box. */
function byWeight(left: ConsumptionRow, right: ConsumptionRow): number {
    return (right.memUsedBytes ?? -1) - (left.memUsedBytes ?? -1);
}

function toRow(bucket: Bucket): ConsumptionRow {
    return {
        id: bucket.id,
        name: bucket.name,
        detail: bucket.detail,
        owner: bucket.owner,
        ...state(bucket),
        containers: bucket.containers,
        cpuPercent: bucket.cpuPercent,
        memUsedBytes: bucket.memUsedBytes,
        href: bucket.href
    };
}

function state(bucket: Bucket): { state: ConsumptionRow["state"]; stateLabel: string } {
    if (bucket.containers === 0) return { state: "elsewhere", stateLabel: "Not on this machine" };
    // A bucket with nothing of its own in it is a tunnel whose record is gone, and
    // the tunnel is the row: its own container is what says whether it is up.
    const [up, total] =
        bucket.self === 0 ? [bucket.running, bucket.containers] : [bucket.selfRunning, bucket.self];
    if (up === 0) return { state: "stopped", stateLabel: "Stopped" };
    if (up < total) return { state: "partial", stateLabel: `${up} of ${total} running` };
    return { state: "running", stateLabel: "Running" };
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}
