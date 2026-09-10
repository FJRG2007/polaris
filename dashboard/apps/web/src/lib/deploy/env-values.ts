/**
 * Reading and copying stored variables with their secrets intact.
 *
 * Two operations every copy of a service or an environment needs, kept in one
 * place because getting either half wrong fails quietly. A secret is stored
 * encrypted with its value column empty, so a copy that takes `value` and
 * nothing else produces a variable that exists and holds nothing - which is
 * exactly what duplicating a service used to do to every secret it had.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { decryptSecret } from "@polaris/storage";

/** The stored columns a variable's value lives in. */
interface StoredValue {
    readonly isSecret: boolean;
    readonly value: string | null;
    readonly encryptedValue: Uint8Array | null;
    readonly valueNonce: Uint8Array | null;
    readonly valueKeyId: string | null;
}

/** A stored variable's value in the clear, or null when it holds none. */
export function decryptedValue(row: StoredValue): string | null {
    if (!row.isSecret) return row.value;
    if (!row.encryptedValue || !row.valueNonce) return null;
    return decryptSecret(
        {
            ciphertext: Buffer.from(row.encryptedValue),
            nonce: Buffer.from(row.valueNonce),
            keyId: row.valueKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** Every variable of one scope, decrypted. Callers authorize the scope first. */
export async function scopeValues(
    scopeType: "application" | "environment",
    scopeId: string
): Promise<Record<string, string>> {
    const rows = await prisma.envVar.findMany({ where: { scopeType, scopeId } });
    const out: Record<string, string> = {};
    for (const row of rows) {
        const value = decryptedValue(row);
        if (value !== null) out[row.key] = value;
    }
    return out;
}

/**
 * Copy one scope's variables onto another, ciphertext and all.
 *
 * The encrypted columns are copied as they are rather than decrypted and sealed
 * again: the key they were sealed under is the same master key, and a copy that
 * never holds the secret in the clear is one less place it can leak from.
 * Variables the destination already has are left alone.
 *
 * `secrets: false` leaves every secret behind and answers the keys it left, for
 * a copy whose code is not trusted with them.
 */
export async function copyScopeValues(
    from: { scopeType: "application" | "environment"; scopeId: string },
    to: { scopeType: "application" | "environment"; scopeId: string },
    options: { secrets?: boolean } = {}
): Promise<{ copied: number; withheld: string[] }> {
    const [rows, existing] = await Promise.all([
        prisma.envVar.findMany({ where: { scopeType: from.scopeType, scopeId: from.scopeId } }),
        prisma.envVar.findMany({
            where: { scopeType: to.scopeType, scopeId: to.scopeId },
            select: { key: true }
        })
    ]);
    const taken = new Set(existing.map((row) => row.key));
    let copied = 0;
    const withheld: string[] = [];
    for (const row of rows) {
        if (taken.has(row.key)) continue;
        if (row.isSecret && options.secrets === false) {
            withheld.push(row.key);
            continue;
        }
        await prisma.envVar.create({
            data: {
                scopeType: to.scopeType,
                scopeId: to.scopeId,
                key: row.key,
                isSecret: row.isSecret,
                value: row.value,
                encryptedValue: row.encryptedValue,
                valueNonce: row.valueNonce,
                valueKeyId: row.valueKeyId
            }
        });
        copied += 1;
    }
    return { copied, withheld };
}
