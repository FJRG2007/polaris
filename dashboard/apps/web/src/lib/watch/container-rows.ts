/**
 * What a running container is called on a CPU or memory breakdown, and what the
 * reader can do about it.
 *
 * A row used to carry one string - the service's name, or "Polaris - Dashboard" -
 * and everything else had to be guessed from a detail line that, for six services
 * of one project, read "Marketplace / Production" six times. So a row now carries
 * every name it has: the one people call it by first, where it lives, and the
 * engine's own container name, so two rows of one project can always be told
 * apart. A container nobody here can name still gets the name the engine gave it;
 * a row with nothing on its first line is the one thing this module exists to
 * rule out.
 *
 * Pure on purpose, so the naming can be pinned down in a test without a daemon.
 */

import type { BreakdownPart } from "./breakdown-shape";
import { baseProject } from "@/lib/deploy/host-volumes";
import type { ContainerStats, ContainerSummary } from "@polaris/docker";
import { describePart, isPolarisPart, partCatalogKey } from "@/lib/polaris-parts";

/** A service Polaris deployed, in the terms a row needs it. */
export interface DeployedApp {
    readonly id: string;
    readonly name: string;
    readonly projectId: string;
    /** "Project / Environment", which is how a service is placed everywhere else. */
    readonly where: string;
    /** How the Deploy app draws it: from a repository or from an image. */
    readonly source: "github" | "image";
    /** Whether the reader may open it in Deploy - the check Deploy itself makes. */
    readonly canOpen: boolean;
    /** Whether the reader may restart it - the check the restart action makes. */
    readonly canRestart: boolean;
}

/**
 * Below this fraction of the machine, a container's memory limit is a cap
 * somebody set rather than the engine reporting the whole machine, which is what
 * it reports for a container with no limit at all.
 */
const LIMIT_BELOW_MACHINE = 0.98;

/** The memory cap set on a container, or null when it may use the whole machine. */
export function memoryLimit(
    stats: ContainerStats | undefined,
    machine: number | null
): number | null {
    const limit = stats?.memLimit;
    if (!limit || !Number.isFinite(limit) || limit <= 0) return null;
    if (machine !== null && machine > 0 && limit >= machine * LIMIT_BELOW_MACHINE) return null;
    return machine === null ? null : limit;
}

/** What to call a container, and where its page is. Three answers in order of how
 *  much is known: part of Polaris itself, a service Polaris deployed, or
 *  something started on the machine that only the Containers screen knows. */
export function describeContainer(
    container: ContainerSummary,
    connectionId: string,
    owners: ReadonlyMap<string, DeployedApp>
): Omit<BreakdownPart, "kind" | "value"> {
    const containerHref = `/apps/containers/${encodeURIComponent(container.name)}?c=${encodeURIComponent(connectionId)}`;
    const engineName = container.name || container.id.slice(0, 12);
    if (isPolarisPart(container)) {
        const part = describePart(container);
        return {
            key: container.id,
            label: part.label || engineName,
            detail: part.summary || null,
            href: containerHref,
            group: "polaris",
            container: engineName,
            part: partCatalogKey(part.label)
        };
    }
    const app = owners.get(baseProject(container.composeProject) ?? "");
    if (app) {
        return {
            key: container.id,
            label: app.name || engineName,
            detail: app.where,
            // The same check Deploy makes: a service the reader cannot open there
            // is named here, but is not a link to a page that would refuse them.
            href: app.canOpen ? `/apps/deploy/${app.projectId}?service=${app.id}` : null,
            group: "apps",
            container: engineName,
            service: { id: app.id, source: app.source, canRestart: app.canRestart }
        };
    }
    return {
        key: container.id,
        label: engineName,
        detail: null,
        href: containerHref,
        group: "other",
        container: engineName,
        image: container.image || null
    };
}

/** Every running container with a reading, as a row of the clicked metric. */
export function containerParts(
    running: readonly ContainerSummary[],
    samples: ReadonlyMap<string, ContainerStats>,
    metric: "cpu" | "mem",
    connectionId: string,
    owners: ReadonlyMap<string, DeployedApp>,
    machineMemory: number | null
): BreakdownPart[] {
    return running.flatMap<BreakdownPart>((container) => {
        const stats = samples.get(container.id);
        if (!stats) return [];
        return [
            {
                ...describeContainer(container, connectionId, owners),
                kind: "container",
                value: metric === "cpu" ? stats.cpuPercent : stats.memUsage,
                limit: metric === "mem" ? memoryLimit(stats, machineMemory) : null
            }
        ];
    });
}
