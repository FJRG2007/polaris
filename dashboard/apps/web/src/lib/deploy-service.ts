/**
 * Deploy orchestration: projects, environments, applications, and the pipeline
 * that turns an application into a running container. A deployment is a database
 * row plus a log file; the runtime driver streams build/deploy output into that
 * file, which the UI tails. Deployments are serialized per target by a small
 * in-memory queue - no external broker - so two deploys of one app never race.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { serviceName, shortHash, slugify, type AppDeployPlan } from "@polaris/deploy";
import { decryptSecret } from "@polaris/storage";
import { getDriver, getPorts, toTargetInfo, type TargetRow } from "./deploy/runtime";

/** Directory the web process writes deploy log files to (tailed by the UI). */
function logDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "deploy-logs");
}

export function deployLogPath(deploymentId: string): string {
    return join(logDir(), `${deploymentId}.log`);
}

// --- projects / environments / applications --------------------------------

export async function listProjects(ownerId: string) {
    return prisma.project.findMany({
        where: { ownerId },
        orderBy: { createdAt: "asc" },
        include: { environments: { include: { applications: true, databases: true } } }
    });
}

export async function getProject(projectId: string, ownerId: string) {
    return prisma.project.findFirst({
        where: { id: projectId, ownerId },
        include: {
            environments: {
                include: { applications: true, databases: true },
                orderBy: { createdAt: "asc" }
            }
        }
    });
}

/** Create a project with a default "production" environment. */
export async function createProject(ownerId: string, name: string) {
    const slug = slugify(name);
    if (!slug) throw new Error("Project name must contain letters or digits");
    return prisma.project.create({
        data: {
            ownerId,
            name,
            slug,
            environments: { create: { name: "Production", slug: "production", isDefault: true } }
        },
        include: { environments: true }
    });
}

export async function deleteProject(projectId: string, ownerId: string) {
    await prisma.project.deleteMany({ where: { id: projectId, ownerId } });
}

export interface CreateApplicationInput {
    environmentId: string;
    targetId: string;
    name: string;
    sourceType: string;
    sourceConfig: Record<string, unknown>;
}

export async function createApplication(ownerId: string, input: CreateApplicationInput) {
    // Confirm the environment and target belong to the owner before creating.
    const environment = await prisma.environment.findFirst({
        where: { id: input.environmentId, project: { ownerId } }
    });
    if (!environment) throw new Error("Environment not found");
    const target = await prisma.deployTarget.findFirst({ where: { id: input.targetId, ownerId } });
    if (!target) throw new Error("Deploy target not found");
    const slug = slugify(input.name);
    if (!slug) throw new Error("Application name must contain letters or digits");
    return prisma.application.create({
        data: {
            environmentId: input.environmentId,
            targetId: input.targetId,
            name: input.name,
            slug,
            sourceType: input.sourceType,
            sourceConfig: JSON.stringify(input.sourceConfig)
        }
    });
}

// --- deployment pipeline ----------------------------------------------------

/** Build the runtime plan for an application from its stored config. */
async function buildAppPlan(applicationId: string, ownerId: string): Promise<{ plan: AppDeployPlan; target: TargetRow }> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true, volumes: true, domains: true }
    });
    if (!app) throw new Error("Application not found");

    const project = app.environment.project;
    const composeProject = `polaris-${shortHash(app.id, 8)}`;
    const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    const env = await mergedEnv(app.environmentId, app.id);
    const healthcheck = app.healthcheck ? (JSON.parse(app.healthcheck) as AppDeployPlan["healthcheck"]) : undefined;

    const plan: AppDeployPlan = {
        ref: { name: serviceName(project.slug, app.slug, app.id), project: composeProject },
        build: {
            method: (app.sourceType as AppDeployPlan["build"]["method"]) ?? "image",
            name: app.slug,
            imageRef: typeof source.imageRef === "string" ? source.imageRef : undefined,
            dockerfilePath: typeof source.dockerfilePath === "string" ? source.dockerfilePath : undefined,
            contextPath: ".",
            composeYaml: typeof source.composeYaml === "string" ? source.composeYaml : undefined
        },
        env,
        replicas: app.replicas,
        domains: app.domains.map((domain) => ({
            hostname: domain.hostname,
            targetPort: domain.targetPort,
            pathPrefix: domain.pathPrefix ?? undefined,
            certResolver: domain.certResolver as "le" | "internal" | "none"
        })),
        volumes: app.volumes.map((volume) => ({
            mountPath: volume.mountPath,
            source: volume.source ?? volume.name,
            kind: volume.kind === "bind" ? "bind" : "volume"
        })),
        healthcheck
    };
    return { plan, target: app.target };
}

/** Merge environment-scoped and application-scoped env vars (app wins), decrypting
 *  any secret values. */
async function mergedEnv(environmentId: string, applicationId: string): Promise<Record<string, string>> {
    const rows = await prisma.envVar.findMany({
        where: {
            OR: [
                { scopeType: "environment", scopeId: environmentId },
                { scopeType: "application", scopeId: applicationId }
            ]
        }
    });
    // Environment scope first, then application scope overrides it.
    rows.sort((a, b) => (a.scopeType === "environment" ? -1 : 1) - (b.scopeType === "environment" ? -1 : 1));
    const masterKey = loadEnv().POLARIS_MASTER_KEY;
    const env: Record<string, string> = {};
    for (const row of rows) {
        if (row.isSecret && row.encryptedValue && row.valueNonce) {
            env[row.key] = decryptSecret(
                {
                    ciphertext: Buffer.from(row.encryptedValue),
                    nonce: Buffer.from(row.valueNonce),
                    keyId: row.valueKeyId ?? ""
                },
                masterKey
            );
        } else if (row.value !== null) {
            env[row.key] = row.value;
        }
    }
    return env;
}

/**
 * Deploy an application: create a queued Deployment row and run it through the
 * per-target queue. Returns the deployment id immediately; the run streams its
 * output to the deployment's log file and updates the row's status.
 */
export async function deployApplication(applicationId: string, ownerId: string, userId: string): Promise<string> {
    const { plan, target } = await buildAppPlan(applicationId, ownerId);
    const deployment = await prisma.deployment.create({
        data: {
            targetId: target.id,
            deployableType: "application",
            deployableId: applicationId,
            status: "queued",
            triggeredById: userId
        }
    });
    await prisma.application.update({ where: { id: applicationId }, data: { currentDeploymentId: deployment.id } });
    queue.enqueue(target.id, () => runDeployment(deployment.id, plan, target, ownerId));
    return deployment.id;
}

async function runDeployment(deploymentId: string, plan: AppDeployPlan, target: TargetRow, ownerId: string): Promise<void> {
    await mkdir(logDir(), { recursive: true });
    const logPath = deployLogPath(deploymentId);
    const logStream = createWriteStream(logPath, { flags: "a" });
    const log = (chunk: Buffer): void => {
        logStream.write(chunk);
    };

    await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "deploying", startedAt: new Date(), logPath: `${deploymentId}.log` }
    });

    const ports = await getPorts(target, ownerId);
    const driver = getDriver(target);
    try {
        const result = await driver.deployApplication(plan, {
            ports,
            target: toTargetInfo(target),
            log
        });
        await prisma.deployment.update({
            where: { id: deploymentId },
            data: {
                status: result.ok ? "running" : "failed",
                imageTag: result.imageTag,
                error: result.error,
                finishedAt: new Date()
            }
        });
    } catch (error) {
        log(Buffer.from(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`));
        await prisma.deployment.update({
            where: { id: deploymentId },
            data: { status: "failed", error: error instanceof Error ? error.message : "deploy failed", finishedAt: new Date() }
        });
    } finally {
        await ports.dispose();
        logStream.end();
    }
}

// --- per-target FIFO queue (no external broker) -----------------------------

class InMemoryQueue {
    private readonly chains = new Map<string, Promise<void>>();

    /** Run `job` after any prior job for the same partition finishes. */
    public enqueue(partition: string, job: () => Promise<void>): void {
        const prior = this.chains.get(partition) ?? Promise.resolve();
        const next = prior.then(job).catch(() => undefined);
        this.chains.set(partition, next);
        // Drop the chain entry once it settles and nothing newer replaced it.
        void next.finally(() => {
            if (this.chains.get(partition) === next) this.chains.delete(partition);
        });
    }
}

const queue = new InMemoryQueue();
