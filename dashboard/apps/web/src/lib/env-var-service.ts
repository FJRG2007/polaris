/**
 * Application environment variables. Stored per application (scopeType
 * "application"); secret values are envelope-encrypted at rest with the master
 * key, plain values kept as-is. The deploy pipeline merges these into the
 * container env (see mergedEnv in deploy-service). Owner-checked via the app's
 * project.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { encryptSecret } from "@polaris/storage";

export interface EnvVarView {
    id: string;
    key: string;
    isSecret: boolean;
    /** Plain value for non-secrets; null for secrets (never returned to the client). */
    value: string | null;
}

async function assertOwnsApp(applicationId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");
}

/** List an application's variables (secret values masked). */
export async function listEnvVars(applicationId: string, ownerId: string): Promise<EnvVarView[]> {
    await assertOwnsApp(applicationId, ownerId);
    const rows = await prisma.envVar.findMany({
        where: { scopeType: "application", scopeId: applicationId },
        orderBy: { key: "asc" }
    });
    return rows.map((row) => ({
        id: row.id,
        key: row.key,
        isSecret: row.isSecret,
        value: row.isSecret ? null : row.value
    }));
}

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Create or replace a variable by key. A secret value is encrypted at rest. */
export async function setEnvVar(
    applicationId: string,
    ownerId: string,
    input: { key: string; value: string; isSecret: boolean }
): Promise<void> {
    await assertOwnsApp(applicationId, ownerId);
    const key = input.key.trim();
    if (!VALID_KEY.test(key)) throw new Error("Key must be letters, digits and underscores, not starting with a digit");

    const existing = await prisma.envVar.findFirst({
        where: { scopeType: "application", scopeId: applicationId, key }
    });

    let data: {
        isSecret: boolean;
        value: string | null;
        encryptedValue: Buffer | null;
        valueNonce: Buffer | null;
        valueKeyId: string | null;
    };
    if (input.isSecret) {
        const blob = encryptSecret(input.value, loadEnv().POLARIS_MASTER_KEY);
        data = { isSecret: true, value: null, encryptedValue: blob.ciphertext, valueNonce: blob.nonce, valueKeyId: blob.keyId };
    } else {
        data = { isSecret: false, value: input.value, encryptedValue: null, valueNonce: null, valueKeyId: null };
    }

    if (existing) {
        await prisma.envVar.update({ where: { id: existing.id }, data });
    } else {
        await prisma.envVar.create({ data: { scopeType: "application", scopeId: applicationId, key, ...data } });
    }
}

/** Delete a variable the owner owns. */
export async function deleteEnvVar(id: string, ownerId: string): Promise<void> {
    const row = await prisma.envVar.findUnique({ where: { id }, select: { scopeId: true, scopeType: true } });
    if (!row || row.scopeType !== "application") return;
    await assertOwnsApp(row.scopeId, ownerId);
    await prisma.envVar.delete({ where: { id } });
}
