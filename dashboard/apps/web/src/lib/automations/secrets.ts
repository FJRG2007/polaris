/**
 * Automation secrets: write-only, envelope encrypted like `OutboundWebhook`.
 *
 * A screen only ever sees the name, the kind and a masked hint. The value is
 * opened in exactly one place - `readSecretForRun`, for a step that needs it -
 * and the engine redacts it from everything the step stores.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { StepRefusal } from "./types";
import type { Shelf } from "./runner";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";

export interface SecretSummary {
    readonly id: string;
    readonly name: string;
    readonly kind: core.SecretKind;
    readonly hint: string;
    readonly lastUsedAt: string | null;
    readonly createdAt: string;
}

function shelfWhere(shelf: Shelf) {
    return shelf.orgId ? { orgId: shelf.orgId } : { userId: shelf.userId, orgId: null };
}

export function secretHint(kind: core.SecretKind, value: string): string {
    if (kind === "url") return core.maskSecretUrl(value);
    if (kind === "basic") return `${value.split(":")[0]}:...`;
    return core.maskToken(value);
}

export async function listSecrets(shelf: Shelf): Promise<SecretSummary[]> {
    const rows = await prisma.automationSecret.findMany({
        where: shelfWhere(shelf),
        orderBy: { createdAt: "desc" },
        take: core.AUTOMATION_LIMITS.secretsPerShelf,
        select: { id: true, name: true, kind: true, hint: true, lastUsedAt: true, createdAt: true }
    });
    return rows.map((row) => ({
        ...row,
        kind: row.kind as core.SecretKind,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    }));
}

export class SecretLimitError extends Error {}

export async function createSecret(
    shelf: Shelf,
    createdById: string,
    input: { name: string; kind: core.SecretKind; value: string }
): Promise<SecretSummary> {
    const held = await prisma.automationSecret.count({ where: shelfWhere(shelf) });
    if (held >= core.AUTOMATION_LIMITS.secretsPerShelf) throw new SecretLimitError("secretLimit");
    const blob = encryptSecret(input.value, loadEnv().POLARIS_MASTER_KEY);
    const row = await prisma.automationSecret.create({
        data: {
            orgId: shelf.orgId,
            userId: shelf.orgId ? null : shelf.userId,
            name: input.name,
            kind: input.kind,
            hint: secretHint(input.kind, input.value),
            encrypted: Buffer.from(blob.ciphertext),
            nonce: Buffer.from(blob.nonce),
            keyId: blob.keyId,
            createdById
        },
        select: { id: true, name: true, kind: true, hint: true, lastUsedAt: true, createdAt: true }
    });
    return { ...row, kind: row.kind as core.SecretKind, lastUsedAt: null, createdAt: row.createdAt.toISOString() };
}

export async function deleteSecret(shelf: Shelf, id: string): Promise<boolean> {
    const gone = await prisma.automationSecret.deleteMany({ where: { id, ...shelfWhere(shelf) } });
    return gone.count === 1;
}

/** A secret's value for a running step: only from the automation's own shelf. */
export async function readSecretForRun(id: string, shelf: Shelf): Promise<string> {
    const row = await prisma.automationSecret.findFirst({
        where: { id, ...shelfWhere(shelf) },
        select: { id: true, encrypted: true, nonce: true, keyId: true }
    });
    if (!row) throw new StepRefusal("secretMissing");
    const value = decryptSecret(
        { ciphertext: Buffer.from(row.encrypted), nonce: Buffer.from(row.nonce), keyId: row.keyId ?? "" },
        loadEnv().POLARIS_MASTER_KEY
    );
    await prisma.automationSecret
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    return value;
}
