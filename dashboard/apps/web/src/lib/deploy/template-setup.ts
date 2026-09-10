/**
 * A one-click service's parts beyond its own container, and its first deploy.
 *
 * `addTemplateParts` creates what a template names beside the service - its
 * managed database, its companion service - and writes the variables and volumes
 * of each, every placeholder turned into the reference it stands for, so the
 * service reads its database's password when it deploys rather than holding a
 * copy of it.
 *
 * `firstTemplateDeploy` then brings them up in the order they need: the database
 * until it answers, the companion until it is up, the service, and once the
 * service is serving, the template's setup commands inside it. That takes
 * minutes, so it runs off the request that created the service, and whatever
 * goes wrong is written into the service's activity - the screen that shows the
 * service is where somebody looking at it will see it. Nothing here is silent.
 *
 * The setup commands run through the same exec every other in-container command
 * uses: the ports to the service's server, into the release serving it now.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomBytes } from "node:crypto";
import { scopeValues } from "./env-values";
import { currentReleaseRef } from "./releases";
import { setEnvVars } from "@/lib/env-var-service";
import * as activity from "@/lib/activity/activity";
import { getPorts, type TargetRow } from "./runtime";
import * as databaseOps from "@/lib/database-ops/ops";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { createVolume } from "@/lib/deploy-volume-service";
import { createDatabase, deployDatabaseAndWait } from "@/lib/database-service";
import { awaitDeployment, createApplication, deployAndWait, deployApplication } from "@/lib/deploy-service";

/** How long one readiness check or setup command is given before it counts as
 *  failed, so a container that never answers cannot hold the setup forever. */
const EXEC_LIMIT_MS = 5 * 60_000;

/** How long a deploy that came up is given to become the one the service points
 *  at. Promotion follows the deploy's own verdict by a few queries. */
const PROMOTION_WAIT_MS = 60_000;

/** What a failure nobody anticipated reads as; the error itself goes to the log. */
const UNEXPECTED = "It stopped on something Polaris did not expect. The details are in the server log.";

/** A secret the way the catalog generates one: 32 random bytes as hex. */
const generateSecret = (): string => randomBytes(32).toString("hex");

/** What a template created beside its service, by the names they were given. */
export interface TemplateParts {
    readonly database: { readonly id: string; readonly name: string } | null;
    readonly companion: { readonly id: string; readonly name: string } | null;
}

/**
 * The source a template's container is created with. The service's own carries
 * the template's id, which is how its setup can be run again later.
 */
export function templateSource(service: core.TemplateService, templateId?: string): Record<string, unknown> {
    return {
        imageRef: service.image,
        port: service.port,
        ...(service.command ? { command: [...service.command] } : {}),
        ...(templateId ? { templateId } : {})
    };
}

/**
 * Create the template's database and companion beside `service`, and write the
 * volumes and variables of every service it makes, the first one's included.
 *
 * The database and companion are named after the service (`blog-db`,
 * `events-broker`), numbered past anything the environment already calls that.
 */
export async function addTemplateParts(input: {
    template: core.ServiceTemplate;
    service: { id: string; slug: string; environmentId: string; targetId: string };
    ownerId: string;
    keepReleases: boolean;
}): Promise<TemplateParts> {
    const { template, service, ownerId } = input;
    const taken = await namesInEnvironment(service.environmentId);

    let database: TemplateParts["database"] = null;
    if (template.database) {
        const row = await createDatabase(ownerId, {
            environmentId: service.environmentId,
            targetId: service.targetId,
            name: core.freeTemplateName(`${service.slug}-db`, taken),
            engine: template.database.engine,
            version: template.database.version,
            privileges: "owner"
        });
        taken.add(row.slug);
        database = { id: row.id, name: row.slug };
    }

    let companion: TemplateParts["companion"] = null;
    if (template.companion) {
        const part = template.companion;
        const row = await createApplication(ownerId, {
            environmentId: service.environmentId,
            targetId: service.targetId,
            name: core.freeTemplateName(`${service.slug}-${part.suffix}`, taken),
            sourceType: "image",
            sourceConfig: templateSource(part),
            keepReleases: input.keepReleases,
            // Reached by name from the service beside it, and from nothing else.
            publishPort: false,
            safeHeaders: true
        });
        await addVolumes(row.id, ownerId, `${template.id}-${part.suffix}`, part.volumes);
        await setEnvVars("application", row.id, ownerId, core.templateVariables(part, { self: row.slug }, generateSecret));
        companion = { id: row.id, name: row.slug };
    }

    await addVolumes(service.id, ownerId, template.id, template.volumes);
    const slugs: core.TemplateSlugs = {
        self: service.slug,
        ...(database ? { database: database.name } : {}),
        ...(companion ? { companion: companion.name } : {})
    };
    await setEnvVars("application", service.id, ownerId, core.templateVariables(template, slugs, generateSecret));
    return { database, companion };
}

/** Every name a reference could mean in an environment: its services' and its
 *  databases' slugs, which a reference reads from one namespace. */
async function namesInEnvironment(environmentId: string): Promise<Set<string>> {
    const [applications, databases] = await Promise.all([
        prisma.application.findMany({ where: { environmentId }, select: { slug: true } }),
        prisma.managedDatabase.findMany({ where: { environmentId }, select: { slug: true } })
    ]);
    return new Set([...applications, ...databases].map((row) => row.slug));
}

async function addVolumes(
    applicationId: string,
    ownerId: string,
    prefix: string,
    volumes: core.TemplateService["volumes"]
): Promise<void> {
    for (const volume of volumes) {
        await createVolume(ownerId, {
            applicationId,
            name: `${prefix}-${volume.name}`,
            mountPath: volume.mountPath,
            kind: "volume"
        });
    }
}

/**
 * Deploy what a template created, in the order it needs, and then run its setup.
 * Never throws: it runs after the request that started it has answered, so what
 * goes wrong is recorded on the service instead.
 */
export async function firstTemplateDeploy(input: {
    template: core.ServiceTemplate;
    applicationId: string;
    parts: TemplateParts;
    ownerId: string;
    userId: string;
}): Promise<void> {
    const { template, applicationId, parts, ownerId, userId } = input;
    try {
        if (parts.database) {
            const reason = await bringUpDatabase(parts.database.id, ownerId, userId);
            if (reason) return await note(applicationId, "setup-blocked", `its database ${parts.database.name}`, reason);
        }
        if (parts.companion && template.companion) {
            const reason = await deployAndWait(parts.companion.id, ownerId, userId);
            await audit(userId, "deploy.app.deploy", "application", parts.companion.id);
            if (reason) {
                return await note(
                    applicationId,
                    "setup-blocked",
                    `its ${template.companion.label} ${parts.companion.name}`,
                    reason
                );
            }
        }
        let deploymentId: string;
        try {
            deploymentId = await deployApplication(applicationId, ownerId, userId);
        } catch (error) {
            const reason = error instanceof Error ? error.message : "The deploy could not be started.";
            return await note(applicationId, "first-deploy-failed", null, reason);
        }
        await audit(userId, "deploy.app.deploy", "application", applicationId);

        const first = template.prepare?.[0];
        if (!first) return;
        if (await awaitDeployment(deploymentId)) {
            const reason = "The first deploy did not come up, so it did not run.";
            return await note(applicationId, "setup-failed", first.title, reason);
        }
        await servingFrom(applicationId, deploymentId);
        await runTemplateSetup(template, applicationId, ownerId);
    } catch (error) {
        console.error(`polaris: the first deploy of service ${applicationId} stopped:`, error);
        await note(applicationId, "first-deploy-failed", null, UNEXPECTED);
    }
}

/**
 * Wait until the service serves from `deploymentId`. Its deploy is marked
 * running a moment before the service is pointed at it, and the setup runs in
 * whichever release the service serves from - so without this it could find
 * the service not running yet, or run in the release before.
 */
async function servingFrom(applicationId: string, deploymentId: string): Promise<void> {
    const deadline = Date.now() + PROMOTION_WAIT_MS;
    while (Date.now() < deadline) {
        const row = await prisma.application.findUnique({
            where: { id: applicationId },
            select: { currentDeploymentId: true }
        });
        if (!row || row.currentDeploymentId === deploymentId) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

/**
 * Deploy a template's database and wait until it answers, or say why not.
 *
 * Up is not answering: MySQL initialises its data folder after its container has
 * started, and a service started against it before then exits, is restarted, and
 * has its deploy counted as failed.
 */
async function bringUpDatabase(databaseId: string, ownerId: string, userId: string): Promise<string | null> {
    const failure = await deployDatabaseAndWait(databaseId, ownerId, userId);
    await audit(userId, "deploy.db.deploy", "database", databaseId);
    if (failure) return failure;
    try {
        const context = await databaseOps.instanceContext(databaseId, ownerId);
        await databaseOps.withPorts(context, (ports) => databaseOps.waitReady(ports, context));
        return null;
    } catch (error) {
        if (error instanceof databaseOps.DatabaseOperationError) return error.message;
        console.error(`polaris: waiting on database ${databaseId} failed:`, error);
        return UNEXPECTED;
    }
}

/**
 * Run a template's setup steps inside the service as it runs now, and record
 * how each went on the service. What a step printed is kept to its last line,
 * with the service's secrets masked out of it.
 */
export async function runTemplateSetup(
    template: core.ServiceTemplate,
    applicationId: string,
    ownerId: string
): Promise<void> {
    const steps = template.prepare ?? [];
    const first = steps[0];
    if (!first) return;
    try {
        const app = await prisma.application.findFirst({
            where: { id: applicationId, environment: { project: { ownerId } } },
            include: { target: true, environment: { select: { project: { select: { slug: true } } } } }
        });
        if (!app) return;
        if (!app.currentDeploymentId || app.desiredState !== "running") {
            const reason = "The service is not running, so there was nothing to run it in.";
            return await note(applicationId, "setup-failed", first.title, reason);
        }
        const values = await scopeValues("application", app.id);
        const secrets = template.secrets.map((key) => values[key] ?? "").filter(Boolean);
        const ports = await getPorts(app.target as TargetRow, ownerId).catch(() => null);
        if (!ports) {
            const reason = "The server the service runs on could not be reached.";
            return await note(applicationId, "setup-failed", first.title, reason);
        }
        let outcomes: core.PrepareOutcome[];
        try {
            const release = await currentReleaseRef(app);
            outcomes = await core.runPrepareSteps(
                steps,
                (command) => databaseOps.runWithin(ports, release.name, ["sh", "-c", command], EXEC_LIMIT_MS),
                (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            );
        } finally {
            await ports.dispose().catch(() => undefined);
        }
        await activity.recordMany(
            outcomes.map((outcome) => {
                const said = databaseOps.lastLine(outcome.output, secrets);
                return {
                    subjectType: "app" as const,
                    subjectId: applicationId,
                    userId: null,
                    action: outcome.ok ? "setup" : "setup-failed",
                    fromValue: outcome.title,
                    toValue: outcome.ok ? said || null : [outcome.reason, said].filter(Boolean).join(" ")
                };
            })
        );
    } catch (error) {
        console.error(`polaris: the setup of service ${applicationId} stopped:`, error);
        await note(applicationId, "setup-failed", first.title, UNEXPECTED);
    }
}

/**
 * Run a service's template setup again, after it failed. Checks what can be
 * checked now and starts it; the outcome lands in the service's activity.
 */
export async function rerunTemplateSetup(applicationId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { sourceConfig: true, currentDeploymentId: true }
    });
    if (!app) throw new Error("Service not found");
    const template = templateOf(app.sourceConfig);
    if (!template?.prepare?.length) throw new Error("This service has no setup to run.");
    if (!app.currentDeploymentId) throw new Error("Deploy the service first - its setup runs inside it.");
    void runTemplateSetup(template, applicationId, ownerId);
}

/** The template a service was created from, when it was created from one. */
function templateOf(sourceConfig: string): core.ServiceTemplate | null {
    try {
        const source = JSON.parse(sourceConfig) as { templateId?: unknown };
        const id = core.serviceTemplateIdSchema.safeParse(source.templateId);
        return id.success ? core.serviceTemplate(id.data) : null;
    } catch {
        return null;
    }
}

async function note(applicationId: string, action: string, fromValue: string | null, toValue: string): Promise<void> {
    await activity
        .record({ subjectType: "app", subjectId: applicationId, userId: null, action, fromValue, toValue })
        .catch((error: unknown) => {
            console.error("polaris: could not record a service's setup:", error);
        });
}

async function audit(actorId: string, action: string, targetType: string, targetId: string): Promise<void> {
    await recordDeployAudit({ actorId, action, targetType, targetId }).catch(() => undefined);
}
