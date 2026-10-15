"use server";

/**
 * Server actions for the keys that can sign in to a server. Every one checks the
 * same permission as the rest of the Servers app, validates against the shared
 * schemas, and records what changed by fingerprint - never the key itself.
 */

import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { sshKeyIssueKey } from "./ssh-key-words";
import { HostNotFoundError } from "@/lib/host-service";
import {
    ServerKeysError,
    addServerKeys,
    generateServerKey,
    githubKeys,
    listServerKeys,
    removeServerKey,
    type GithubKeyAccount,
    type ServerKeysView
} from "@/lib/server-ssh-keys";
import {
    addServerKeysSchema,
    generateServerKeySchema,
    removeServerKeySchema,
    serverKeysTargetSchema
} from "@polaris/core";

async function say(caught: unknown): Promise<string> {
    const t = await getTranslations("servers");
    if (caught instanceof ServerKeysError) return t(`sshKeys.problems.${caught.problem}`);
    if (caught instanceof HostNotFoundError) return t("sshKeys.problems.notFound");
    // Anything else names internals; it is logged here and said generically.
    console.error("[server-ssh-keys]", caught instanceof Error ? caught.name : "error");
    return t("sshKeys.problems.failed");
}

async function sayIssue(message: string | undefined): Promise<string> {
    const t = await getTranslations("servers");
    return t(sshKeyIssueKey(message));
}

export async function serverKeysAction(input: {
    hostId: string;
    login?: string;
}): Promise<{ view?: ServerKeysView; error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = serverKeysTargetSchema
        .partial({ login: true })
        .safeParse(input);
    if (!parsed.success) return { error: await sayIssue(parsed.error.issues[0]?.message) };
    try {
        return { view: await listServerKeys(parsed.data.hostId, user.id, parsed.data.login) };
    } catch (caught) {
        return { error: await say(caught) };
    }
}

export async function addServerKeysAction(input: unknown): Promise<{ added?: number; error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = addServerKeysSchema.safeParse(input);
    if (!parsed.success) return { error: await sayIssue(parsed.error.issues[0]?.message) };
    const { hostId, login, keys } = parsed.data;
    try {
        const result = await addServerKeys(hostId, user.id, login, keys);
        await recordAudit({
            actorId: user.id,
            action: "host.ssh-key.add",
            targetType: "host",
            targetId: hostId,
            metadata: { login, fingerprints: result.fingerprints, added: result.added }
        });
        return { added: result.added };
    } catch (caught) {
        return { error: await say(caught) };
    }
}

export async function removeServerKeyAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = removeServerKeySchema.safeParse(input);
    if (!parsed.success) return { error: await sayIssue(parsed.error.issues[0]?.message) };
    const { hostId, login, fingerprint } = parsed.data;
    try {
        await removeServerKey(hostId, user.id, login, fingerprint);
        await recordAudit({
            actorId: user.id,
            action: "host.ssh-key.remove",
            targetType: "host",
            targetId: hostId,
            metadata: { login, fingerprint }
        });
        return {};
    } catch (caught) {
        return { error: await say(caught) };
    }
}

/** The private key in the answer is the only copy there will ever be: it is not
 *  stored, logged or audited, and the panel shows it once. */
export async function generateServerKeyAction(input: unknown): Promise<{
    key?: { privateKey: string; publicKey: string; fingerprint: string };
    error?: string;
}> {
    const user = await requirePermission("system.manage");
    const parsed = generateServerKeySchema.safeParse(input);
    if (!parsed.success) return { error: await sayIssue(parsed.error.issues[0]?.message) };
    const { hostId, login, label } = parsed.data;
    try {
        const key = await generateServerKey(hostId, user.id, login, label);
        await recordAudit({
            actorId: user.id,
            action: "host.ssh-key.generate",
            targetType: "host",
            targetId: hostId,
            metadata: { login, fingerprint: key.fingerprint }
        });
        return { key };
    } catch (caught) {
        return { error: await say(caught) };
    }
}

/** The keys on the reader's linked GitHub accounts; `linked: false` when there
 *  are none, so the panel can say where to link one. */
export async function githubKeysAction(): Promise<{ linked: boolean; accounts: GithubKeyAccount[] }> {
    const user = await requirePermission("system.manage");
    const accounts = await githubKeys(user.id).catch(() => []);
    return accounts === null ? { linked: false, accounts: [] } : { linked: true, accounts };
}
