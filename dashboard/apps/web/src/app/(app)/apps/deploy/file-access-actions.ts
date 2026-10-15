"use server";

/**
 * A service's SFTP accounts. Reading them asks for `files.read`; adding or
 * removing one reaches the service's files, so it asks for `files.write`.
 * Nothing here returns a password: it is sealed as it is saved and only ever
 * opened to be hashed for the server.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { reply } from "./reply";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import * as access from "@/lib/deploy/file-access";
import type { NamespaceKey } from "@/lib/i18n/types";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

async function failure(
    caught: unknown,
    fallback: NamespaceKey<"deployServer">
): Promise<{ error: string }> {
    if (caught instanceof access.FileAccessError)
        return { error: (await refusal(caught.message, caught.params)) ?? (await reply(fallback)) };
    console.error("polaris: an SFTP account action failed:", caught);
    return { error: await reply(fallback) };
}

/** A refusal key of the `fileAccess` group in the reader's language, or null for one this build does not know. */
async function refusal(key: string, params?: core.MessageParams): Promise<string | null> {
    const t = await getTranslations("deployServer");
    return t.has(key) ? t(key as NamespaceKey<"deployServer">, params) : null;
}

/** The account schema's issue keys live in the `deployData` catalog, where the form reads them too. */
async function accountIssue(error: { issues: readonly { message: string }[] }): Promise<string> {
    const t = await getTranslations("deployData");
    const key = error.issues[0]?.message;
    return key && t.has(key)
        ? t(key as NamespaceKey<"deployData">)
        : reply("fileAccess.saveFailed");
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
        const view = await access.fileAccessView(parsed.data, granted.ownerId);
        const lastError = view.server?.lastError;
        if (!view.server || !lastError) return { view };
        const said =
            (await refusal(lastError, { port: view.server.port })) ??
            (await reply("fileAccess.startFailed", { port: view.server.port }));
        return { view: { ...view, server: { ...view.server, lastError: said } } };
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
    if (!parsed.success) return { error: await accountIssue(parsed.error) };
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
    const parsed = z
        .object({ applicationId: idSchema, accountId: idSchema })
        .safeParse({ applicationId, accountId });
    if (!parsed.success) return { error: await reply("fileAccess.removeFailed") };
    try {
        const user = await requirePermission("deploy.manage");
        const granted = await requireApplicationAccess(
            parsed.data.applicationId,
            user.id,
            "files.write"
        );
        await access.deleteFileAccessAccount(
            parsed.data.applicationId,
            granted.ownerId,
            parsed.data.accountId
        );
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
