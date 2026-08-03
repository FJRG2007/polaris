/**
 * The values a pool's runners carry into a job.
 *
 * GitHub's own secrets are handed to a workflow by GitHub, and nothing here
 * replaces them. These are the other half: what the operator wants their own
 * machines to hold - a registry login, an endpoint that only exists inside the
 * network, a signing key that should not be uploaded to GitHub at all. They
 * arrive in the runner's environment, so a workflow step reads them the way it
 * reads any other environment variable (`$MY_TOKEN`), not through the
 * `secrets.` context, which only GitHub can fill in.
 *
 * Scope is the registration, and that is not a simplification: GitHub registers
 * a runner against exactly one repository, so a secret attached to that
 * repository is in reach of its jobs and cannot be in reach of anybody else's.
 * A pool registered at the organization level is one runner for every repository
 * in the organization at once, which is why a secret cannot be narrowed below
 * the pool there - and the screen that offers it says so rather than pretending.
 *
 * Values are envelope-encrypted at rest with the master key, like every other
 * credential Polaris holds, and are never returned to the client once written.
 * Reading one back is a deliberate act by the owner, and it is audited.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { recordAudit } from "@/lib/audit-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { secretKeyRefusal, secretValueRefusal } from "@polaris/core";

/** Every repository the pool serves. Stored as an empty string rather than null
 *  so the unique index actually holds - two nulls are not equal in SQL, and a
 *  pool could otherwise collect two of the same pool-wide secret. */
export const POOL_WIDE = "";

/** A secret as the dashboard shows it: everything except the value. */
export interface RunnerSecretView {
    id: string;
    key: string;
    /** "" for every repository the pool serves, else the "owner/repo" it is for. */
    scopeKey: string;
    updatedAt: string;
}

/** Confirm the signed-in owner owns the pool a secret is being read or written
 *  through. Every entry point goes through this rather than trusting an id that
 *  arrived from a form. */
async function assertOwnsPool(poolId: string, ownerId: string): Promise<void> {
    const pool = await prisma.runnerPool.findFirst({ where: { id: poolId, ownerId }, select: { id: true } });
    if (!pool) throw new Error("Pool not found");
}

/** Every secret of a pool, values withheld. */
export async function listRunnerSecrets(poolId: string, ownerId: string): Promise<RunnerSecretView[]> {
    await assertOwnsPool(poolId, ownerId);
    const rows = await prisma.runnerSecret.findMany({
        where: { poolId },
        select: { id: true, key: true, scopeKey: true, updatedAt: true },
        orderBy: [{ scopeKey: "asc" }, { key: "asc" }]
    });
    return rows.map((row) => ({
        id: row.id,
        key: row.key,
        scopeKey: row.scopeKey,
        updatedAt: row.updatedAt.toISOString()
    }));
}

/** Create or replace a secret by name within its scope. */
export async function setRunnerSecret(
    ownerId: string,
    input: { poolId: string; key: string; value: string; scopeKey: string }
): Promise<void> {
    await assertOwnsPool(input.poolId, ownerId);
    const refusal = secretKeyRefusal(input.key) ?? secretValueRefusal(input.value);
    if (refusal) throw new Error(refusal);

    const key = input.key.trim();
    const scopeKey = input.scopeKey.trim();
    // A scope that names a repository has to be one the pool actually serves,
    // otherwise it is a secret that will never reach anything and reads on the
    // screen as though it does.
    if (scopeKey !== POOL_WIDE) {
        const target = await prisma.runnerPoolTarget.findFirst({
            where: { poolId: input.poolId, key: scopeKey },
            select: { id: true }
        });
        if (!target) throw new Error("This pool does not serve that repository");
    }

    const blob = encryptSecret(input.value, loadEnv().POLARIS_MASTER_KEY);
    const data = { encryptedValue: blob.ciphertext, valueNonce: blob.nonce, valueKeyId: blob.keyId };
    await prisma.runnerSecret.upsert({
        where: { poolId_scopeKey_key: { poolId: input.poolId, scopeKey, key } },
        create: { poolId: input.poolId, scopeKey, key, ...data },
        update: data
    });

    // The name and where it applies, never the value - an audit trail that
    // records what it was protecting is not one.
    await recordAudit({
        actorId: ownerId,
        action: "runner.secret.set",
        targetType: "runnerPool",
        targetId: input.poolId,
        metadata: { key, scope: scopeKey || "pool" }
    });
}

export async function deleteRunnerSecret(ownerId: string, secretId: string): Promise<void> {
    const row = await prisma.runnerSecret.findUnique({
        where: { id: secretId },
        select: { poolId: true, key: true, scopeKey: true }
    });
    if (!row) return;
    await assertOwnsPool(row.poolId, ownerId);
    await prisma.runnerSecret.delete({ where: { id: secretId } });
    await recordAudit({
        actorId: ownerId,
        action: "runner.secret.delete",
        targetType: "runnerPool",
        targetId: row.poolId,
        metadata: { key: row.key, scope: row.scopeKey || "pool" }
    });
}

/**
 * Show one secret's value to the owner who set it.
 *
 * Kept as its own deliberate act rather than something a listing returns,
 * because a list that carries every value is a list that leaks all of them to
 * anything that can read one response. Audited for the same reason: reading a
 * secret back is worth a line in the log even when the person doing it is
 * entitled to.
 */
export async function revealRunnerSecret(ownerId: string, secretId: string): Promise<string | null> {
    const row = await prisma.runnerSecret.findUnique({ where: { id: secretId } });
    if (!row) return null;
    await assertOwnsPool(row.poolId, ownerId);
    await recordAudit({
        actorId: ownerId,
        action: "runner.secret.reveal",
        targetType: "runnerPool",
        targetId: row.poolId,
        metadata: { key: row.key, scope: row.scopeKey || "pool" }
    });
    return decryptSecret(
        {
            ciphertext: Buffer.from(row.encryptedValue),
            nonce: Buffer.from(row.valueNonce),
            keyId: row.valueKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/**
 * The environment one runner is started with: the pool's secrets, with the ones
 * set for this repository laid over them.
 *
 * A repository-specific value winning over a pool-wide one of the same name is
 * the useful way round - a pool sets a default and one repository needs its own
 * - and it is also the safe way round, because narrowing is what an operator
 * reaches for when a repository should not have the shared one.
 *
 * `allowed` is the policy answer for this repository. A repository whose secrets
 * are turned off gets an empty environment rather than a filtered one: there is
 * nothing to filter, and a bug that half-applied the setting would be a leak.
 */
export async function secretsForTarget(
    poolId: string,
    targetKey: string,
    options: { allowed: boolean }
): Promise<Record<string, string>> {
    if (!options.allowed) return {};
    const rows = await prisma.runnerSecret.findMany({
        where: { poolId, scopeKey: { in: [POOL_WIDE, targetKey] } },
        orderBy: { scopeKey: "asc" }
    });

    const key = loadEnv().POLARIS_MASTER_KEY;
    const env: Record<string, string> = {};
    for (const row of rows) {
        // A value encrypted under a master key that has since changed cannot be
        // read, and that is one secret missing from one job - not a reason to
        // start the runner with none of them or not at all.
        try {
            env[row.key] = decryptSecret(
                {
                    ciphertext: Buffer.from(row.encryptedValue),
                    nonce: Buffer.from(row.valueNonce),
                    keyId: row.valueKeyId
                },
                key
            );
        } catch {
            continue;
        }
    }
    return env;
}
