/**
 * Application environment variables. Stored per application (scopeType
 * "application"); secret values are envelope-encrypted at rest with the master
 * key, plain values kept as-is. The deploy pipeline merges these into the
 * container env (see mergedEnv in deploy-service). Owner-checked via the app's
 * project.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { ENV_VALUE_MAX, envValueMessage, hasControlCharacter } from "@polaris/core";

export interface EnvVarView {
    id: string;
    key: string;
    isSecret: boolean;
    /** Plain value for non-secrets; null for secrets (never returned to the client). */
    value: string | null;
}

export type EnvScope = "application" | "environment";

/** Confirm the signed-in owner owns the app or environment the scope points at. */
async function assertOwnsScope(scope: EnvScope, scopeId: string, ownerId: string): Promise<void> {
    if (scope === "environment") {
        const env = await prisma.environment.findFirst({
            where: { id: scopeId, project: { ownerId } },
            select: { id: true }
        });
        if (!env) throw new Error("Environment not found");
        return;
    }
    const app = await prisma.application.findFirst({
        where: { id: scopeId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");
}

/**
 * Which scope one variable belongs to, so a caller holding only its id can
 * resolve who is allowed to touch it before it does. Null when the row is gone
 * or names a scope this module does not own.
 *
 * The key comes back too, for the audit entry the caller writes: a reveal or a
 * removal recorded without the name of what was revealed or removed says only
 * that something happened.
 */
export async function envVarScope(
    id: string
): Promise<{ scope: EnvScope; scopeId: string; key: string } | null> {
    const row = await prisma.envVar.findUnique({
        where: { id },
        select: { scopeId: true, scopeType: true, key: true }
    });
    if (!row || (row.scopeType !== "application" && row.scopeType !== "environment")) return null;
    return { scope: row.scopeType as EnvScope, scopeId: row.scopeId, key: row.key };
}

/** List a scope's variables (secret values masked). Application scope is a service;
 *  environment scope is shared by every service in that environment. */
export async function listEnvVars(
    scope: EnvScope,
    scopeId: string,
    ownerId: string
): Promise<EnvVarView[]> {
    await assertOwnsScope(scope, scopeId, ownerId);
    const rows = await prisma.envVar.findMany({
        where: { scopeType: scope, scopeId },
        orderBy: { key: "asc" }
    });
    return rows.map((row) => ({
        id: row.id,
        key: row.key,
        isSecret: row.isSecret,
        value: row.isSecret ? null : row.value
    }));
}

/** Reveal a single variable's value, decrypting a secret on demand (owner-gated).
 *  Used by the eye toggle so a secret is only sent to the client when asked for. */
export async function revealEnvVar(id: string, ownerId: string): Promise<string | null> {
    const row = await prisma.envVar.findUnique({ where: { id } });
    if (!row || (row.scopeType !== "application" && row.scopeType !== "environment")) return null;
    await assertOwnsScope(row.scopeType as EnvScope, row.scopeId, ownerId);
    if (!row.isSecret) return row.value;
    if (!row.encryptedValue || !row.valueNonce || !row.valueKeyId) return null;
    return decryptSecret(
        {
            ciphertext: Buffer.from(row.encryptedValue),
            nonce: Buffer.from(row.valueNonce),
            keyId: row.valueKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Create or replace a variable by key. A secret value is encrypted at rest. */
export async function setEnvVar(
    scope: EnvScope,
    scopeId: string,
    ownerId: string,
    input: { key: string; value: string; isSecret: boolean }
): Promise<void> {
    await assertOwnsScope(scope, scopeId, ownerId);
    const key = input.key.trim();
    if (!VALID_KEY.test(key))
        throw new Error("Key must be letters, digits and underscores, not starting with a digit");
    if (hasControlCharacter(input.value)) throw new Error(envValueMessage(key));
    if (input.value.length > ENV_VALUE_MAX) throw new Error(`${key} is longer than ${ENV_VALUE_MAX / 1024} KB.`);

    const existing = await prisma.envVar.findFirst({
        where: { scopeType: scope, scopeId, key }
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
        data = {
            isSecret: true,
            value: null,
            encryptedValue: blob.ciphertext,
            valueNonce: blob.nonce,
            valueKeyId: blob.keyId
        };
    } else {
        data = {
            isSecret: false,
            value: input.value,
            encryptedValue: null,
            valueNonce: null,
            valueKeyId: null
        };
    }

    if (existing) {
        await prisma.envVar.update({ where: { id: existing.id }, data });
    } else {
        await prisma.envVar.create({ data: { scopeType: scope, scopeId, key, ...data } });
    }
}

/** Moved to a pure module so the browser can stage a paste; kept here for callers. */
export { parseDotEnv } from "./deploy/dotenv";

/**
 * Mark a variable secret or plain without its value leaving the server: a
 * plain value is sealed where it stands, a secret is opened and stored as text.
 * Nothing to do when it already is what was asked.
 */
export async function setEnvVarSecrecy(id: string, ownerId: string, isSecret: boolean): Promise<void> {
    const row = await prisma.envVar.findUnique({ where: { id } });
    if (!row || (row.scopeType !== "application" && row.scopeType !== "environment")) {
        throw new Error("That variable no longer exists");
    }
    await assertOwnsScope(row.scopeType as EnvScope, row.scopeId, ownerId);
    if (row.isSecret === isSecret) return;
    const value = row.isSecret ? await revealEnvVar(id, ownerId) : row.value;
    await setEnvVar(row.scopeType as EnvScope, row.scopeId, ownerId, {
        key: row.key,
        value: value ?? "",
        isSecret
    });
}

/** Set many variables at once (used by the .env paste import). */
export async function setEnvVars(
    scope: EnvScope,
    scopeId: string,
    ownerId: string,
    vars: Array<{ key: string; value: string; isSecret: boolean }>
): Promise<number> {
    await assertOwnsScope(scope, scopeId, ownerId);
    let saved = 0;
    for (const item of vars) {
        try {
            await setEnvVar(scope, scopeId, ownerId, item);
            saved += 1;
        } catch {
            // Skip an invalid key; import the rest.
        }
    }
    return saved;
}

/** Delete a variable the owner owns; returns its scope so the caller can redeploy. */
export async function deleteEnvVar(
    id: string,
    ownerId: string
): Promise<{ scope: EnvScope; scopeId: string } | null> {
    const row = await prisma.envVar.findUnique({
        where: { id },
        select: { scopeId: true, scopeType: true }
    });
    if (!row || (row.scopeType !== "application" && row.scopeType !== "environment")) return null;
    await assertOwnsScope(row.scopeType as EnvScope, row.scopeId, ownerId);
    await prisma.envVar.delete({ where: { id } });
    return { scope: row.scopeType as EnvScope, scopeId: row.scopeId };
}
