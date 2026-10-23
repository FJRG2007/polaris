/**
 * Pointing a service at another repository, or at none.
 *
 * Neither touches what is running: the current deployment keeps serving until
 * somebody deploys again. Disconnecting only stops pushes from deploying and
 * forgets where the code came from; changing re-points the next deploy and the
 * pushes it listens for. Whatever push the service was holding for CI is
 * dropped with the old source, and the last deployed commit is forgotten so the
 * new repository's head is taken as a baseline rather than compared with a
 * commit from somewhere else.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { dropCiWait } from "./ci-wait";
import * as activity from "@/lib/activity/activity";
import { describeServiceSource } from "./service-source";

/** What a repository change asks for, as the picker sends it. */
export const repointSourceSchema = z.object({
    repoFullName: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
    branch: z
        .string()
        .trim()
        .max(255)
        // A git ref name: no spaces, control characters, ".." or a leading "-".
        .refine(
            (value) => value === "" || /^(?!-)(?!.*\.\.)[^\s~^:?*[\\\x00-\x1f\x7f]+$/.test(value)
        )
});

export type RepointSource = z.infer<typeof repointSourceSchema>;

/** Source types built from code; only these have a repository to change. */
const BUILT = ["dockerfile", "nixpacks"];

async function loadApp(applicationId: string, ownerId: string) {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: {
            id: true,
            sourceType: true,
            sourceConfig: true,
            deployBranch: true,
            environment: { select: { branch: true } }
        }
    });
    if (!app) throw new Error("Service not found");
    return app;
}

function parsedSource(raw: string): Record<string, unknown> {
    try {
        const value = JSON.parse(raw || "{}") as unknown;
        return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function sourceName(app: Awaited<ReturnType<typeof loadApp>>): string | null {
    const view = describeServiceSource({
        sourceType: app.sourceType,
        sourceConfig: app.sourceConfig,
        deployBranch: app.deployBranch,
        environmentBranch: app.environment.branch
    });
    return view.kind === "repository" ? view.name : null;
}

/**
 * Disconnect the repository. Answers the name it was connected to, or null when
 * it had none (nothing is written then).
 */
export async function disconnectSource(
    applicationId: string,
    ownerId: string,
    actorId: string
): Promise<string | null> {
    const app = await loadApp(applicationId, ownerId);
    const name = sourceName(app);
    if (!name) return null;
    // The root directory, Dockerfile and port stay: they describe the code, and
    // the next repository or upload is most likely the same code.
    const kept = parsedSource(app.sourceConfig);
    delete kept.repoUrl;
    delete kept.provider;
    delete kept.branch;
    await prisma.application.update({
        where: { id: app.id },
        data: {
            sourceConfig: JSON.stringify(kept),
            autoDeploy: false,
            deployBranch: null,
            lastDeployedSha: null
        }
    });
    await dropCiWait(app.id);
    await activity.record({
        subjectType: "app",
        subjectId: app.id,
        userId: actorId,
        action: "source-disconnected",
        fromValue: name
    });
    return name;
}

/** Point a built service at another GitHub repository and branch. */
export async function repointSource(
    applicationId: string,
    ownerId: string,
    actorId: string,
    input: RepointSource
): Promise<void> {
    const app = await loadApp(applicationId, ownerId);
    if (!BUILT.includes(app.sourceType)) throw new Error("This service runs an image, not code");
    const before = sourceName(app);
    const source = parsedSource(app.sourceConfig);
    const branch = input.branch || undefined;
    const next = {
        ...source,
        repoUrl: `https://github.com/${input.repoFullName}`,
        provider: "github",
        branch
    };
    await prisma.application.update({
        where: { id: app.id },
        data: {
            sourceConfig: JSON.stringify(next),
            deployBranch: branch ?? null,
            lastDeployedSha: null
        }
    });
    await dropCiWait(app.id);
    await activity.record({
        subjectType: "app",
        subjectId: app.id,
        userId: actorId,
        action: "source-changed",
        fromValue: before,
        toValue: branch ? `${input.repoFullName}@${branch}` : input.repoFullName
    });
}
