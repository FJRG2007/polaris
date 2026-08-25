/**
 * What the machine Polaris runs on is being spent on, split by what is spending
 * it.
 *
 * The Containers table answers "what is running" and the footprint card answers
 * "what does the control plane cost". Neither answers the operator's actual
 * question, which is where the box went: how much of it is Polaris, how much is
 * the apps somebody installed from the marketplace, how much is the services
 * deployed on it, and how much is something nobody here started. That question is
 * only answerable today by reading a list of containers and knowing, by eye, which
 * of them is which - and the names do not say.
 *
 * This is the half that reaches the engine and the database. The rule that decides
 * whose container is whose, and the adding up, are pure and live in `consumption`.
 *
 * Deliberately cheap. The figures come from the sampler the Containers app and the
 * metrics collector already share - a listing, plus whatever was last sampled -
 * rather than a fresh `stats` call per container, which is a second each. Disk is
 * not here at all: measuring it means asking every container to walk its own
 * volumes, which is what `polaris-footprint` does for the stack alone and is not
 * something to do for the whole machine behind a page.
 */

import { prisma } from "@polaris/db";
import { findApp } from "@/lib/apps/catalog";
import { visibleProjectIds } from "@/lib/deploy-service";
import type { Consumption } from "@/app/(app)/admin/consumption/types";
import { localDockerDriver, LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";
import { attribute, subjectHash, type Claim, type ClaimIndex } from "@/lib/consumption";
import {
    cachedSamples,
    oldestSampleAt,
    refreshSamples,
    STATS_TTL_MS
} from "@/lib/container-stats-cache";

/**
 * Read the split.
 *
 * @param viewerId Who is looking. Used for the sampler (which is keyed by the
 *                 connection, not by them) and to decide which rows they can
 *                 actually open - a link into a project they cannot read is worse
 *                 than no link.
 */
export async function readConsumption(viewerId: string): Promise<Consumption> {
    // The engine listing and the records are independent, and this endpoint exists
    // to cost a listing plus a handful of queries rather than the sum of both.
    const [[containers, info], index] = await Promise.all([
        (async () => {
            const driver = localDockerDriver();
            try {
                return await Promise.all([
                    driver.listContainers(true),
                    driver.info().catch(() => null)
                ]);
            } finally {
                await driver.dispose().catch(() => undefined);
            }
        })(),
        readIndex(viewerId)
    ]);

    const samples = cachedSamples(LOCAL_DOCKER_CONNECTION_ID);
    const groups = attribute(
        containers.map((container) => {
            // A stopped container has nothing to sample, and its last reading is
            // not carried: the row already says it is stopped, and a figure beside
            // that reads as though it still were running.
            const sample =
                container.state === "running" ? (samples.get(container.id) ?? null) : null;
            return {
                ...container,
                cpuPercent: sample ? Math.round(sample.stats.cpuPercent * 10) / 10 : null,
                memUsedBytes: sample?.stats.memUsage ?? null
            };
        }),
        index,
        LOCAL_DOCKER_CONNECTION_ID
    );

    const running = containers.filter((container) => container.state === "running");
    const sampledAt = oldestSampleAt(
        samples,
        running.map((container) => container.id)
    );
    // Behind the answer, never in front of it, and single-flight per host - so two
    // admins on this screen do not sample the same engine twice.
    if (sampledAt === null || Date.now() - sampledAt > STATS_TTL_MS) {
        refreshSamples(
            LOCAL_DOCKER_CONNECTION_ID,
            viewerId,
            running.map((container) => ({ id: container.id, name: container.name })),
            { prune: true }
        );
    }

    return {
        machine: {
            name: info?.name ?? "This machine",
            ncpu: info?.ncpu ?? 0,
            memTotalBytes: info?.memTotal ?? null
        },
        groups,
        sampledAt,
        at: new Date().toISOString()
    };
}

/**
 * Read what the deployment has, once, so attribution is a map lookup per container
 * rather than a query per container.
 *
 * Everything, not the viewer's own: this is an operator screen, and figures that
 * stop at the reader's own shelf do not answer where the machine went. Which of
 * those rows they may open is a separate question, and the one `visible` settles.
 */
async function readIndex(viewerId: string): Promise<ClaimIndex> {
    const [applications, databases, installs, visible] = await Promise.all([
        prisma.application.findMany({
            select: {
                id: true,
                name: true,
                environment: {
                    select: {
                        name: true,
                        projectId: true,
                        project: { select: { name: true, ownerId: true } }
                    }
                }
            }
        }),
        prisma.managedDatabase.findMany({
            select: {
                id: true,
                name: true,
                engine: true,
                version: true,
                environment: {
                    select: { projectId: true, project: { select: { name: true, ownerId: true } } }
                }
            }
        }),
        prisma.installedApp.findMany({
            where: { status: { not: "removed" }, applicationId: { not: null } },
            select: { id: true, name: true, catalogId: true, applicationId: true, ownerId: true }
        }),
        visibleProjectIds(viewerId)
    ]);

    const owners = await ownerNames([
        ...applications.map((application) => application.environment.project.ownerId),
        ...databases.map((database) => database.environment.project.ownerId),
        ...installs.map((install) => install.ownerId)
    ]);

    const byApplication = new Map(applications.map((application) => [application.id, application]));
    const index = {
        applications: new Map<string, Claim>(),
        databases: new Map<string, Claim>(),
        installs: new Map<string, Claim>()
    };

    for (const application of applications) {
        const project = application.environment.project;
        index.applications.set(subjectHash(application.id), {
            key: `service:${application.id}`,
            bucket: {
                id: application.id,
                name: application.name,
                detail: `${project.name} / ${application.environment.name}`,
                owner: owners.get(project.ownerId) ?? null,
                group: "services",
                href: visible.has(application.environment.projectId)
                    ? `/apps/deploy/${application.environment.projectId}?service=${application.id}`
                    : null
            }
        });
    }

    for (const database of databases) {
        const project = database.environment.project;
        index.databases.set(subjectHash(database.id), {
            key: `database:${database.id}`,
            bucket: {
                id: database.id,
                name: database.name,
                detail: `${database.engine} ${database.version} - ${project.name}`,
                owner: owners.get(project.ownerId) ?? null,
                group: "services",
                href: visible.has(database.environment.projectId)
                    ? `/apps/deploy/${database.environment.projectId}`
                    : null
            }
        });
    }

    // Installs last, and they overwrite the service they are backed by: a
    // marketplace app IS a deployed service with an install record in front of it,
    // and the operator knows it as the app they installed rather than as the
    // service slug it happens to run under.
    for (const install of installs) {
        const application = install.applicationId
            ? byApplication.get(install.applicationId)
            : undefined;
        if (!application) continue;
        const claim: Claim = {
            key: `install:${install.id}`,
            bucket: {
                id: install.id,
                name: install.name,
                detail: findApp(install.catalogId)?.name ?? install.catalogId,
                owner: owners.get(install.ownerId) ?? null,
                group: "apps",
                href: `/apps/installed/${install.id}`
            }
        };
        index.applications.set(subjectHash(application.id), claim);
        index.installs.set(claim.key, claim);
    }

    return index;
}

/** What to call each owner. One query for every shelf on the screen. */
async function ownerNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await prisma.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true }
    });
    return new Map(users.map((user) => [user.id, user.name]));
}
