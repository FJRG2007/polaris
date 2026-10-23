"use server";

/**
 * Where a service's image is built, the folder it was uploaded from, and the
 * repository it is connected to: the actions behind those settings. Each changes
 * how the service is built, so they ask for `service.configure`.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { reply } from "./reply";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import type { NamespaceKey } from "@/lib/i18n/types";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as buildMachine from "@/lib/deploy/build-machine";
import { parseGithubRepo } from "@/lib/repo-reference";
import { githubChecksAccess } from "@/lib/github-service";
import { githubRepoChoiceRefusal } from "@/lib/github-access";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import * as sourceConnection from "@/lib/deploy/source-connection";
import { uploadedSourceOf, type UploadedSource } from "@/lib/deploy/source-upload";
import { describeServiceSource, type ServiceSourceView } from "@/lib/deploy/service-source";

const DEPLOY_PATH = "/apps/deploy";

async function failure(
    caught: unknown,
    fallback: NamespaceKey<"deployServer">
): Promise<{ error: string }> {
    return { error: caught instanceof Error ? caught.message : await reply(fallback) };
}

export async function buildMachineAction(
    applicationId: string
): Promise<{ error?: string; view?: buildMachine.BuildMachineView }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        return { view: await buildMachine.buildMachineOptions(applicationId, access.ownerId) };
    } catch (caught) {
        return failure(caught, "source.machineLoadFailed");
    }
}

export async function setBuildMachineAction(
    applicationId: string,
    value: unknown
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = buildMachine.buildOnSchema.safeParse(value);
    if (!parsed.success) return { error: await reply("source.machineUnknown") };
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "service.configure");
        await buildMachine.setBuildMachine(applicationId, access.ownerId, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.buildOn",
            targetType: "application",
            targetId: applicationId,
            metadata: { buildOn: parsed.data || "runs-on" }
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "source.machineSaveFailed");
    }
}

/**
 * The folder a service was last built from, when it is built from an upload;
 * `uploadable` says whether it can take one at all - not a service that runs an
 * image or builds from a repository.
 */
export async function uploadedSourceAction(
    applicationId: string
): Promise<{ error?: string; upload?: UploadedSource | null; uploadable?: boolean }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        const app = await prisma.application.findFirst({
            where: { id: applicationId, environment: { project: { ownerId: access.ownerId } } },
            select: { sourceType: true, sourceConfig: true }
        });
        if (!app) return { error: await reply("common.serviceNotFound") };
        const source = JSON.parse(app.sourceConfig || "{}") as Record<string, unknown>;
        const fromRepository = typeof source.repoUrl === "string" && source.repoUrl.length > 0;
        const uploadable =
            !fromRepository && (app.sourceType === "dockerfile" || app.sourceType === "nixpacks");
        return { upload: uploadedSourceOf(source), uploadable };
    } catch (caught) {
        return failure(caught, "source.loadFailed");
    }
}

/**
 * Where the service's code or image comes from, for the Source card: the
 * repository and the branch it follows, an uploaded folder, or an image. Read
 * by anybody who can see the project, like the rest of the tab.
 */
export async function serviceSourceAction(
    applicationId: string
): Promise<{ error?: string; source?: ServiceSourceView }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        const app = await prisma.application.findFirst({
            where: { id: applicationId, environment: { project: { ownerId: access.ownerId } } },
            select: {
                sourceType: true,
                sourceConfig: true,
                deployBranch: true,
                environment: { select: { branch: true } }
            }
        });
        if (!app) return { error: await reply("common.serviceNotFound") };
        return {
            source: describeServiceSource({
                sourceType: app.sourceType,
                sourceConfig: app.sourceConfig,
                deployBranch: app.deployBranch,
                environmentBranch: app.environment.branch
            })
        };
    } catch (caught) {
        return failure(caught, "source.loadFailed");
    }
}

/**
 * Disconnect the service's repository. The deployment running now keeps
 * running; pushes stop deploying it and the next deploy needs a source.
 */
export async function disconnectSourceAction(applicationId: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const id = z.string().uuid().safeParse(applicationId);
    if (!id.success) return { error: await reply("common.serviceNotFound") };
    try {
        const access = await requireApplicationAccess(id.data, user.id, "service.configure");
        const name = await sourceConnection.disconnectSource(id.data, access.ownerId, user.id);
        if (name) {
            await recordDeployAudit({
                actorId: user.id,
                action: "deploy.app.source.disconnect",
                targetType: "application",
                targetId: id.data,
                metadata: { repository: name }
            });
        }
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "source.disconnectFailed");
    }
}

/**
 * Point the service at another GitHub repository and branch, picked from the
 * repositories this person can see - the same check a new service gets.
 */
export async function changeSourceAction(
    applicationId: unknown,
    input: unknown
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const id = z.string().uuid().safeParse(applicationId);
    if (!id.success) return { error: await reply("common.serviceNotFound") };
    const parsed = sourceConnection.repointSourceSchema.safeParse(input);
    if (!parsed.success) return { error: await reply("source.repositoryInvalid") };
    try {
        const access = await requireApplicationAccess(id.data, user.id, "service.configure");
        const refusal = await githubRepoChoiceRefusal(
            user,
            access.ownerId,
            `https://github.com/${parsed.data.repoFullName}`
        );
        if (refusal) return { error: refusal };
        await sourceConnection.repointSource(id.data, access.ownerId, user.id, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.source.change",
            targetType: "application",
            targetId: id.data,
            metadata: { repository: parsed.data.repoFullName, branch: parsed.data.branch || null }
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "source.changeFailed");
    }
}

/**
 * Whether "Wait for CI" can work for this service as GitHub is set up now: what
 * is missing, and the page on GitHub where it is turned on. Only an administrator
 * is told what to change on GitHub; anybody else learns that it is theirs to fix.
 */
export async function ciAccessAction(applicationId: unknown): Promise<{
    error?: string;
    access?: { gap: "app" | "install" | "events" | "admins" | null; url: string | null };
}> {
    const user = await requirePermission("deploy.read");
    const id = z.string().uuid().safeParse(applicationId);
    if (!id.success) return { error: await reply("common.serviceNotFound") };
    try {
        const access = await requireApplicationAccess(id.data, user.id, "project.read");
        const app = await prisma.application.findFirst({
            where: { id: id.data, environment: { project: { ownerId: access.ownerId } } },
            select: { sourceConfig: true }
        });
        if (!app) return { error: await reply("common.serviceNotFound") };
        const source = JSON.parse(app.sourceConfig || "{}") as Record<string, unknown>;
        const repo = typeof source.repoUrl === "string" ? parseGithubRepo(source.repoUrl) : null;
        if (!repo) return { access: { gap: null, url: null } };
        const found = (await githubChecksAccess(repo.owner)) ?? { gap: null, url: null };
        if (user.isAdmin) return { access: found };
        return {
            access: {
                gap: found.gap === "app" || found.gap === "install" ? "admins" : null,
                url: null
            }
        };
    } catch (caught) {
        return failure(caught, "source.loadFailed");
    }
}
