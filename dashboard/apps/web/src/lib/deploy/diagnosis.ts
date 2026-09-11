/**
 * A failed deploy's likely cause, and the fix it offers, applied.
 *
 * The reading is `diagnoseDeploy` in the deploy package, over the tail of the
 * deploy's own log and the reason it was recorded with. Applying a fix changes the
 * one setting the diagnosis named and starts a new deploy, so the reader goes from
 * a red row to a build with the fix in it in one press - and the fix is recorded,
 * like any other change to how a service runs.
 */

import { prisma } from "@polaris/db";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { deployLogPath } from "./log-file";
import { setEnvVar } from "@/lib/env-var-service";
import type { DeployFixInput } from "@polaris/core";
import { diagnoseDeploy, normalizeRoot, type Diagnosis } from "@polaris/deploy";
import { containerPortOf, deployApplication, setApplicationPort } from "@/lib/deploy-service";

/** How much of the end of a log is read. The cause is near where it stopped. */
const LOG_TAIL_BYTES = 256 * 1024;

/** The deploy statuses a diagnosis is offered for. */
const FAILED = new Set(["failed", "cancelled"]);

/** The last `LOG_TAIL_BYTES` of a deploy's log, or "" when there is none. */
async function logTail(deploymentId: string): Promise<string> {
    let handle;
    try {
        handle = await open(deployLogPath(deploymentId), "r");
        const { size } = await handle.stat();
        const length = Math.min(size, LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        return buffer.toString("utf8");
    } catch {
        return "";
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function failedDeployment(deploymentId: string) {
    const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { id: true, status: true, error: true, deployableType: true, deployableId: true }
    });
    return deployment && FAILED.has(deployment.status) ? deployment : null;
}

type FailedDeployment = NonNullable<Awaited<ReturnType<typeof failedDeployment>>>;

async function applicationOf(deployment: FailedDeployment, ownerId: string) {
    if (deployment.deployableType !== "application") return null;
    return prisma.application.findFirst({
        where: { id: deployment.deployableId, environment: { project: { ownerId } } },
        select: {
            id: true,
            sourceType: true,
            sourceConfig: true,
            buildConfig: true,
            domains: { select: { targetPort: true }, take: 1 }
        }
    });
}

async function isOwnedDatabase(deployment: FailedDeployment, ownerId: string): Promise<boolean> {
    if (deployment.deployableType !== "database") return false;
    const row = await prisma.managedDatabase.findFirst({
        where: { id: deployment.deployableId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    return row !== null;
}

async function failedApplicationDeployment(deploymentId: string, ownerId: string) {
    const deployment = await failedDeployment(deploymentId);
    const app = deployment ? await applicationOf(deployment, ownerId) : null;
    return deployment && app ? { deployment, app } : null;
}

/** Why this failed deploy failed, when its log says; null when it does not. */
export async function diagnoseDeployment(deploymentId: string, ownerId: string): Promise<Diagnosis | null> {
    const deployment = await failedDeployment(deploymentId);
    if (!deployment) return null;
    const app = await applicationOf(deployment, ownerId);
    if (app) {
        const log = await logTail(deploymentId);
        return diagnoseDeploy(`${log}\n${deployment.error ?? ""}`, { port: containerPortOf(app) });
    }
    if (!(await isOwnedDatabase(deployment, ownerId))) return null;
    // A database has none of the settings a fix changes, so only a cause with
    // nothing to change on the service can be its own.
    const found = diagnoseDeploy(`${await logTail(deploymentId)}\n${deployment.error ?? ""}`);
    return found?.fix === null ? found : null;
}

/** A secret a framework accepts. Laravel's key has a shape of its own. */
function generatedSecret(name: string): string {
    return name === "APP_KEY" ? `base64:${randomBytes(32).toString("base64")}` : randomBytes(32).toString("base64url");
}

/**
 * Change the setting a fix names and deploy again. Answers the new deployment.
 */
export async function applyDeployFix(
    deploymentId: string,
    ownerId: string,
    userId: string,
    fix: DeployFixInput
): Promise<string> {
    const found = await failedApplicationDeployment(deploymentId, ownerId);
    if (!found) throw new Error("That deploy is not a failed one of a service here");
    const { app } = found;
    const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    const build = JSON.parse(app.buildConfig) as Record<string, unknown>;
    const save = () =>
        prisma.application.update({
            where: { id: app.id },
            data: { sourceConfig: JSON.stringify(source), buildConfig: JSON.stringify(build) }
        });

    switch (fix.kind) {
        case "set-port":
            await setApplicationPort(app.id, ownerId, fix.port);
            break;
        case "set-start-command":
            build.startCommand = fix.value;
            await save();
            break;
        case "set-build-command":
            // Empty hands the phase back to detection.
            build.buildCommand = fix.value || undefined;
            await save();
            break;
        case "set-root-directory":
            source.rootDirectory = normalizeRoot(fix.value);
            await save();
            break;
        case "set-runtime-version":
            build.runtimeVersion = fix.version;
            await save();
            break;
        case "add-variable":
            await setEnvVar("application", app.id, ownerId, {
                key: fix.name,
                value: fix.generate ? generatedSecret(fix.name) : (fix.value ?? ""),
                // A generated value is a secret by definition; a typed one is when its
                // name says it is a credential.
                isSecret: fix.generate || /SECRET|TOKEN|PASSWORD|PRIVATE|_KEY$/i.test(fix.name)
            });
            break;
        case "use-detected-build":
            if (app.sourceType === "dockerfile") {
                source.dockerfilePath = undefined;
                build.languageImages = true;
                await prisma.application.update({
                    where: { id: app.id },
                    data: {
                        sourceType: "nixpacks",
                        sourceConfig: JSON.stringify(source),
                        buildConfig: JSON.stringify(build)
                    }
                });
            }
            break;
    }
    return deployApplication(app.id, ownerId, userId);
}
