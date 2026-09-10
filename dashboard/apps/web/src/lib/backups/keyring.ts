/**
 * The keys backups are sealed under.
 *
 * One ring per owner. The newest key that is not retired seals new copies; every
 * key, retired or not, stays to open what it sealed - which is what makes rotating
 * one safe. Each key is 32 random bytes, wrapped under the master key the same way
 * every stored credential is, so a database dump alone opens nothing.
 *
 * The wrapped key lives in this instance's database, and a backup is what somebody
 * reaches for when that database is gone. So a key can be read out as a recovery
 * key - its id and its bytes in one line - and brought into another Polaris, which
 * can then open the copies it finds.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { decryptSecret, encryptSecret } from "@polaris/storage";

/** What a recovery key starts with, so a pasted line is recognisable as one. */
const RECOVERY_PREFIX = "polaris-backup-key";

/** Raised when a key a copy names cannot be found or unwrapped here. */
export class BackupKeyError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "BackupKeyError";
    }
}

export interface BackupKeyView {
    readonly id: string;
    readonly createdAt: string;
    readonly retiredAt: string | null;
    /** How many copies it sealed that still exist. */
    readonly copies: number;
}

function wrap(key: Buffer) {
    const sealed = encryptSecret(key.toString("base64"), loadEnv().POLARIS_MASTER_KEY);
    return { encryptedKey: sealed.ciphertext, keyNonce: sealed.nonce, keyKeyId: sealed.keyId };
}

function unwrap(row: { encryptedKey: Uint8Array; keyNonce: Uint8Array; keyKeyId: string }): Buffer {
    try {
        const plain = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedKey),
                nonce: Buffer.from(row.keyNonce),
                keyId: row.keyKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        return Buffer.from(plain, "base64");
    } catch {
        throw new BackupKeyError(
            "This backup key was stored under a different master key. Add its recovery key to open the copies it sealed."
        );
    }
}

/** The key new copies are sealed under, made the first time it is asked for. */
export async function sealingKey(ownerId: string): Promise<{ id: string; key: Buffer }> {
    const current = await prisma.backupKey.findFirst({
        where: { ownerId, retiredAt: null },
        orderBy: { createdAt: "desc" }
    });
    if (current) return { id: current.id, key: unwrap(current) };
    const key = randomBytes(32);
    const row = await prisma.backupKey.create({
        data: { ownerId, ...wrap(key) },
        select: { id: true }
    });
    return { id: row.id, key };
}

/** The key with this id, for opening a copy it sealed. */
export async function keyById(ownerId: string, id: string): Promise<Buffer> {
    const row = await prisma.backupKey.findFirst({ where: { id, ownerId } });
    if (!row) {
        throw new BackupKeyError(
            "This copy was sealed under a key this Polaris does not have. Add its recovery key first."
        );
    }
    return unwrap(row);
}

/** Every key on an owner's ring, newest first. */
export async function listKeys(ownerId: string): Promise<BackupKeyView[]> {
    const rows = await prisma.backupKey.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, retiredAt: true }
    });
    const counts = await prisma.recoveryPointCopy.groupBy({
        by: ["sealedWith"],
        where: { sealedWith: { in: rows.map((row) => row.id) } },
        _count: { _all: true }
    });
    const byKey = new Map(counts.map((entry) => [entry.sealedWith, entry._count._all]));
    return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        retiredAt: row.retiredAt?.toISOString() ?? null,
        copies: byKey.get(row.id) ?? 0
    }));
}

/** Retire the sealing key and start a new one. What the old one sealed still opens. */
export async function rotateKey(ownerId: string): Promise<{ id: string }> {
    const key = randomBytes(32);
    return prisma.$transaction(async (tx) => {
        await tx.backupKey.updateMany({
            where: { ownerId, retiredAt: null },
            data: { retiredAt: new Date() }
        });
        return tx.backupKey.create({ data: { ownerId, ...wrap(key) }, select: { id: true } });
    });
}

/** One key as a line somebody can keep: its id and its bytes. */
export async function recoveryKey(ownerId: string, id: string): Promise<string> {
    const key = await keyById(ownerId, id);
    return `${RECOVERY_PREFIX}:${id}:${key.toString("base64url")}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read a pasted recovery key, or say what is wrong with it. */
export function parseRecoveryKey(text: string): { id: string; key: Buffer } | { error: string } {
    const parts = text.trim().split(":");
    if (parts.length !== 3 || parts[0] !== RECOVERY_PREFIX) {
        return { error: `A recovery key starts with ${RECOVERY_PREFIX}: and has three parts` };
    }
    const [, id = "", encoded = ""] = parts;
    if (!UUID.test(id)) return { error: "The key's id is not one Polaris writes" };
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded)
        return { error: "The key itself is not 32 bytes" };
    return { id: id.toLowerCase(), key };
}

/** The stored key when this instance's master key still unwraps it, null when it does not. */
function unwrapped(row: {
    encryptedKey: Uint8Array;
    keyNonce: Uint8Array;
    keyKeyId: string;
}): Buffer | null {
    try {
        return unwrap(row);
    } catch {
        return null;
    }
}

/**
 * Bring a key from another Polaris onto this owner's ring, retired - it only opens
 * copies, it never seals new ones. Answers whether it was new here.
 *
 * A key already on the ring is only ever replaced when the stored one no longer
 * unwraps. While it does, the pasted bytes have to be the same bytes: a typo in
 * the encoded part still decodes to 32 bytes, and letting it overwrite the real
 * key would leave every copy that key sealed unopenable.
 */
export async function addRecoveryKey(ownerId: string, text: string): Promise<{ added: boolean }> {
    const parsed = parseRecoveryKey(text);
    if ("error" in parsed) throw new BackupKeyError(parsed.error);
    const existing = await prisma.backupKey.findUnique({
        where: { id: parsed.id },
        select: { ownerId: true, encryptedKey: true, keyNonce: true, keyKeyId: true }
    });
    if (existing) {
        if (existing.ownerId !== ownerId)
            throw new BackupKeyError("That key belongs to somebody else here");
        const stored = unwrapped(existing);
        if (stored) {
            if (stored.length !== parsed.key.length || !timingSafeEqual(stored, parsed.key)) {
                throw new BackupKeyError(
                    "That recovery key does not match the key already stored here under the same id. Check it for a typo."
                );
            }
            return { added: false };
        }
        // Stored again under this instance's master key: the one it had was
        // wrapped under a master key that has since changed.
        await prisma.backupKey.update({ where: { id: parsed.id }, data: wrap(parsed.key) });
        return { added: false };
    }
    await prisma.backupKey.create({
        data: { id: parsed.id, ownerId, ...wrap(parsed.key), retiredAt: new Date() }
    });
    return { added: true };
}
