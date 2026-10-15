/**
 * Promoting one environment into another: staging into production, say.
 *
 * Each service in the target that has a twin of the same slug in the source is
 * deployed again with what the twin runs - the same image, or the same commit
 * of the same repository - through the ordinary deploy, so the release that
 * serves now keeps serving until the new one is up and healthy. Nothing is
 * stopped first.
 *
 * When asked, each paired database's contents are replaced with the source's
 * before any service moves, so the code arrives to the data it was tested
 * with. Every target database gets a restore point first, kept in Backups,
 * whether or not it was protected before. A WordPress copied this way is told
 * its new address, or it would send every visitor back to the source's.
 *
 * Runs on demand only, in the request's process, and leaves nothing running.
 */

import { prisma } from "@polaris/db";
import {
    parseWordpressPrefixes,
    planPromotion,
    wordpressAddressCommand,
    wordpressPrefixesCommand,
    type PromotionPlan
} from "@polaris/core";

/** One line of the history: what happened to one service or database. */
export interface PromotionStep {
    readonly kind: "service" | "database";
    readonly name: string;
    readonly outcome: "deployed" | "copied" | "skipped" | "failed";
    /** Why it was skipped, said on screen in the reader's words. */
    readonly reason?: PromotionSkipReason;
    /** What went wrong, for a failure. */
    readonly detail?: string;
}

export type PromotionSkipReason =
    | "missing"
    | "engine"
    | "dataFailed"
    | "builtDifferently"
    | "noImage"
    | "otherRepository"
    | "notDeployed";

/** A promotion still marked running after this long died with its process. */
const ABANDONED_AFTER_MS = 3 * 60 * 60_000;

const SERVICE_SELECT = {
    id: true,
    slug: true,
    name: true,
    sourceType: true,
    sourceConfig: true,
    currentDeploymentId: true
} as const;

const DATABASE_SELECT = { id: true, slug: true, name: true, engine: true, parentId: true } as const;

/** Both environments, inside the one project and owner, with what they hold. */
async function loadPair(projectId: string, ownerId: string, sourceId: string, targetId: string) {
    const environments = await prisma.environment.findMany({
        where: { id: { in: [sourceId, targetId] }, projectId, project: { ownerId } },
        select: {
            id: true,
            name: true,
            stage: true,
            isDefault: true,
            applications: { select: SERVICE_SELECT, take: 500 },
            databases: { select: DATABASE_SELECT, take: 500 }
        }
    });
    const source = environments.find((environment) => environment.id === sourceId);
    const target = environments.find((environment) => environment.id === targetId);
    if (!source || !target) throw new Error("Environment not found");
    return { source, target };
}

export interface PromotionPreview {
    readonly sourceName: string;
    readonly targetName: string;
    readonly plan: PromotionPlan;
    /** A promotion into the target that has not finished yet, if any. */
    readonly running: boolean;
}

/** What promoting `sourceId` into `targetId` would overwrite. */
export async function previewPromotion(
    projectId: string,
    ownerId: string,
    sourceId: string,
    targetId: string
): Promise<PromotionPreview> {
    const { source, target } = await loadPair(projectId, ownerId, sourceId, targetId);
    return {
        sourceName: source.name,
        targetName: target.name,
        plan: planPromotion(
            { services: source.applications, databases: source.databases },
            { services: target.applications, databases: target.databases }
        ),
        running: (await runningInto(targetId)) !== null
    };
}

async function runningInto(targetId: string): Promise<{ id: string } | null> {
    return prisma.environmentPromotion.findFirst({
        where: {
            targetEnvironmentId: targetId,
            status: "running",
            createdAt: { gt: new Date(Date.now() - ABANDONED_AFTER_MS) }
        },
        select: { id: true }
    });
}

/**
 * Record a promotion and start it. Answers once it is recorded; the work runs
 * on, and its history row says how each service and database went.
 */
export async function startPromotion(input: {
    projectId: string;
    ownerId: string;
    actorId: string;
    sourceId: string;
    targetId: string;
    includeData: boolean;
}): Promise<{ id: string }> {
    const { source, target } = await loadPair(input.projectId, input.ownerId, input.sourceId, input.targetId);
    if (await runningInto(target.id)) throw new Error(`${target.name} is already being promoted into. Wait for that to finish.`);
    const plan = planPromotion(
        { services: source.applications, databases: source.databases },
        { services: target.applications, databases: target.databases }
    );
    if (plan.services.length === 0 && (!input.includeData || plan.databases.length === 0))
        throw new Error(`${target.name} has nothing in common with ${source.name} to promote.`);
    const row = await prisma.environmentPromotion.create({
        data: {
            projectId: input.projectId,
            sourceEnvironmentId: source.id,
            targetEnvironmentId: target.id,
            sourceName: source.name,
            targetName: target.name,
            includeData: input.includeData,
            actorId: input.actorId
        },
        select: { id: true }
    });
    void runPromotion(row.id, input, plan, source.applications, target.applications).catch(async (error: unknown) => {
        console.error("polaris: a promotion stopped partway:", error);
        await prisma.environmentPromotion
            .update({ where: { id: row.id }, data: { status: "failed", finishedAt: new Date() } })
            .catch(() => undefined);
    });
    return row;
}

type ServiceRow = { id: string; name: string; sourceType: string; sourceConfig: string; currentDeploymentId: string | null };

async function runPromotion(
    promotionId: string,
    input: { ownerId: string; actorId: string; includeData: boolean },
    plan: PromotionPlan,
    sourceServices: readonly ServiceRow[],
    targetServices: readonly ServiceRow[]
): Promise<void> {
    const steps: PromotionStep[] = plan.skipped.map((skip) => ({
        kind: skip.kind,
        name: skip.name,
        outcome: "skipped",
        reason: skip.reason
    }));
    const save = (status?: string) =>
        prisma.environmentPromotion.update({
            where: { id: promotionId },
            data: { steps: JSON.stringify(steps), ...(status ? { status, finishedAt: new Date() } : {}) }
        });

    const copied: string[] = [];
    if (input.includeData) {
        const { copyInto } = await import("@/lib/database-ops/copy");
        for (const pair of plan.databases) {
            try {
                await copyInto(
                    pair.targetId,
                    input.ownerId,
                    input.actorId,
                    { fromDatabaseId: pair.sourceId },
                    { alwaysBackUp: true, wait: true }
                );
                copied.push(pair.targetId);
                steps.push({ kind: "database", name: pair.name, outcome: "copied" });
            } catch (error) {
                steps.push({ kind: "database", name: pair.name, outcome: "failed", detail: readable(error) });
            }
            await save();
        }
        // New code on old data is the one outcome worse than no promotion at
        // all, so a failed copy stops the services from moving.
        if (steps.some((step) => step.kind === "database" && step.outcome === "failed")) {
            for (const pair of plan.services)
                steps.push({ kind: "service", name: pair.name, outcome: "skipped", reason: "dataFailed" });
            await save("failed");
            return;
        }
        await pointWordpressAtTarget(plan, copied, input.ownerId, sourceServices, targetServices).catch((error: unknown) => {
            console.error("polaris: a promoted WordPress could not be given its address:", error);
        });
    }

    const deployService = await import("@/lib/deploy-service");
    const sources = new Map(sourceServices.map((service) => [service.id, service]));
    const targets = new Map(targetServices.map((service) => [service.id, service]));
    for (const pair of plan.services) {
        const from = sources.get(pair.sourceId);
        const into = targets.get(pair.targetId);
        if (!from || !into) continue;
        try {
            const release = await releaseOf(from, into);
            if ("skip" in release) {
                steps.push({ kind: "service", name: pair.name, outcome: "skipped", reason: release.skip });
            } else {
                if (release.imageRef) await setImage(into, release.imageRef);
                await deployService.deployApplication(into.id, input.ownerId, input.actorId, {
                    ...(release.commitSha ? { commitSha: release.commitSha } : {}),
                    trigger: "promotion"
                });
                if (release.commitSha)
                    // The poller would otherwise see its branch head and deploy that over it.
                    await prisma.application.update({ where: { id: into.id }, data: { lastDeployedSha: release.commitSha } });
                steps.push({ kind: "service", name: pair.name, outcome: "deployed" });
            }
        } catch (error) {
            steps.push({ kind: "service", name: pair.name, outcome: "failed", detail: readable(error) });
        }
        await save();
    }
    const failed = steps.filter((step) => step.outcome === "failed").length;
    const done = steps.filter((step) => step.outcome === "deployed" || step.outcome === "copied").length;
    await save(failed === 0 ? "succeeded" : done > 0 ? "partial" : "failed");
}

function parseSource(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/**
 * What the target should run to match the source: the source's image, or the
 * commit its live release was built from. Only between services built the same
 * way from the same place - anything else would be a different service.
 */
async function releaseOf(
    from: ServiceRow,
    into: ServiceRow
): Promise<{ imageRef?: string; commitSha?: string } | { skip: PromotionSkipReason }> {
    if (from.sourceType !== into.sourceType) return { skip: "builtDifferently" };
    const fromSource = parseSource(from.sourceConfig);
    const intoSource = parseSource(into.sourceConfig);
    if (from.sourceType === "image") {
        const imageRef = typeof fromSource.imageRef === "string" ? fromSource.imageRef : "";
        return imageRef ? { imageRef } : { skip: "noImage" };
    }
    if (typeof fromSource.repoUrl === "string" && fromSource.repoUrl !== intoSource.repoUrl)
        return { skip: "otherRepository" };
    if (!from.currentDeploymentId) return { skip: "notDeployed" };
    const live = await prisma.deployment.findUnique({
        where: { id: from.currentDeploymentId },
        select: { commitSha: true }
    });
    return live?.commitSha ? { commitSha: live.commitSha } : {};
}

async function setImage(into: ServiceRow, imageRef: string): Promise<void> {
    const current = await prisma.application.findUnique({ where: { id: into.id }, select: { sourceConfig: true } });
    const source = parseSource(current?.sourceConfig ?? "{}");
    if (source.imageRef === imageRef) return;
    await prisma.application.update({
        where: { id: into.id },
        data: { sourceConfig: JSON.stringify({ ...source, imageRef }) }
    });
}

/** Whether a service runs the WordPress image. */
function runsWordpress(service: ServiceRow): boolean {
    const image = parseSource(service.sourceConfig).imageRef;
    return typeof image === "string" && /^(?:docker\.io\/)?(?:library\/)?wordpress(?::|@|$)/.test(image);
}

/** The address a service answers on first. */
async function primaryHost(applicationId: string): Promise<string | null> {
    const domain = await prisma.domain.findFirst({
        where: { applicationId, enabled: true, pathPrefix: null },
        orderBy: { createdAt: "asc" },
        select: { hostname: true }
    });
    return domain?.hostname ?? null;
}

/**
 * Tell each copied MySQL or MariaDB database that a promoted WordPress uses
 * where it now lives: its `home`, `siteurl` and post links still name the
 * source's address.
 */
async function pointWordpressAtTarget(
    plan: PromotionPlan,
    copied: readonly string[],
    ownerId: string,
    sourceServices: readonly ServiceRow[],
    targetServices: readonly ServiceRow[]
): Promise<void> {
    const moves: { from: string; to: string }[] = [];
    for (const pair of plan.services) {
        const from = sourceServices.find((service) => service.id === pair.sourceId);
        const into = targetServices.find((service) => service.id === pair.targetId);
        if (!from || !into || !runsWordpress(into)) continue;
        const [fromHost, toHost] = await Promise.all([primaryHost(from.id), primaryHost(into.id)]);
        if (fromHost && toHost && fromHost !== toHost) moves.push({ from: fromHost, to: toHost });
    }
    if (moves.length === 0) return;
    const { instanceContext, withPorts, runStep } = await import("@/lib/database-ops/ops");
    for (const databaseId of copied) {
        const context = await instanceContext(databaseId, ownerId);
        if (context.engine !== "mysql" && context.engine !== "mariadb") continue;
        const client = {
            engine: context.engine,
            username: context.own.username,
            password: context.own.password,
            database: context.own.database
        };
        await withPorts(context, async (ports) => {
            const listed = await runStep(ports, context.container, wordpressPrefixesCommand(client), [client.password]);
            const prefixes = parseWordpressPrefixes(listed);
            for (const move of moves) {
                const command = wordpressAddressCommand(client, { prefixes, ...move });
                if (command) await runStep(ports, context.container, command, [client.password]);
            }
        });
    }
}

/** A message written for the screen, or a generic one: anything else can name
 *  internals, and is logged instead. */
function readable(error: unknown): string {
    if (error instanceof Error && error.name === "DatabaseOperationError") return error.message;
    console.error("polaris: a promotion step failed:", error);
    return "it did not go through";
}

export interface PromotionView {
    readonly id: string;
    readonly sourceName: string;
    readonly targetName: string;
    readonly includeData: boolean;
    readonly status: "running" | "succeeded" | "partial" | "failed";
    readonly steps: PromotionStep[];
    readonly createdAt: string;
    readonly finishedAt: string | null;
}

/** The project's latest promotions, newest first. */
export async function listPromotions(projectId: string, limit = 10): Promise<PromotionView[]> {
    const rows = await prisma.environmentPromotion.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
            id: true,
            sourceName: true,
            targetName: true,
            includeData: true,
            status: true,
            steps: true,
            createdAt: true,
            finishedAt: true
        }
    });
    const cutoff = Date.now() - ABANDONED_AFTER_MS;
    return rows.map((row) => {
        let steps: PromotionStep[] = [];
        try {
            const parsed = JSON.parse(row.steps) as unknown;
            if (Array.isArray(parsed)) steps = parsed as PromotionStep[];
        } catch {
            steps = [];
        }
        const status =
            row.status === "running" && row.createdAt.getTime() < cutoff ? "failed" : (row.status as PromotionView["status"]);
        return {
            id: row.id,
            sourceName: row.sourceName,
            targetName: row.targetName,
            includeData: row.includeData,
            status,
            steps,
            createdAt: row.createdAt.toISOString(),
            finishedAt: row.finishedAt?.toISOString() ?? null
        };
    });
}
