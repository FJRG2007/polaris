"use server";

/**
 * A service's SFTP accounts. Reading them asks for `files.read`; adding or
 * removing one reaches the service's files, so it asks for `files.write`.
 * Nothing here returns a password: it is sealed as it is saved and only ever
 * opened to start the server.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { firstIssue, reply } from "./reply";
import { requirePermission } from "@/lib/session";
import * as access from "@/lib/deploy/file-access";
import type { NamespaceKey } from "@/lib/i18n/types";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

async function failure(caught: unknown, fallback: NamespaceKey<"deployServer">): Promise<{ error: string }> {
    if (caught instanceof access.FileAccessError) return { error: caught.message };
    console.error("polaris: an SFTP account action failed:", caught);
    return { error: await reply(fallback) };
}

const idSchema = z.string().uuid();

export async function fileAccessAction(
    applicationId: string
): Promise<{ error?: string; view?: access.FileAccessView }> {
    const parsed = idSchema.safeParse(applicationId);
    if (!parsed.success) return { error: await reply("fileAccess.loadFailed") };
    try {
        const user = await requirePermission("deploy.read");
        const granted = await requireApplicationAccess(parsed.data, user.id, "files.read");
        return { view: await access.fileAccessView(parsed.data, granted.ownerId) };
    } catch (caught) {
        return failure(caught, "fileAccess.loadFailed");
    }
}

export async function createFileAccessAccountAction(
    applicationId: string,
    input: unknown
): Promise<{ error?: string }> {
    const id = idSchema.safeParse(applicationId);
    if (!id.success) return { error: await reply("fileAccess.saveFailed") };
    const parsed = core.fileAccessAccountSchema.safeParse(input);
    if (!parsed.success) return { error: await firstIssue(parsed.error, "fileAccess.saveFailed") };
    try {
        const user = await requirePermission("deploy.manage");
        const granted = await requireApplicationAccess(id.data, user.id, "files.write");
        await access.createFileAccessAccount(id.data, granted.ownerId, user.id, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.fileAccess.create",
            targetType: "application",
            targetId: id.data,
            metadata: {
                username: parsed.data.username,
                readOnly: parsed.data.readOnly,
                password: parsed.data.password !== undefined,
                key: parsed.data.publicKey !== undefined
            }
        });
        return {};
    } catch (caught) {
        return failure(caught, "fileAccess.saveFailed");
    }
}

export async function deleteFileAccessAccountAction(
    applicationId: string,
    accountId: string
): Promise<{ error?: string }> {
    const parsed = z.object({ applicationId: idSchema, accountId: idSchema }).safeParse({ applicationId, accountId });
    if (!parsed.success) return { error: await reply("fileAccess.removeFailed") };
    try {
        const user = await requirePermission("deploy.manage");
        const granted = await requireApplicationAccess(parsed.data.applicationId, user.id, "files.write");
        await access.deleteFileAccessAccount(parsed.data.applicationId, granted.ownerId, parsed.data.accountId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.fileAccess.delete",
            targetType: "application",
            targetId: parsed.data.applicationId,
            metadata: { accountId: parsed.data.accountId }
        });
        return {};
    } catch (caught) {
        return failure(caught, "fileAccess.removeFailed");
    }
}
