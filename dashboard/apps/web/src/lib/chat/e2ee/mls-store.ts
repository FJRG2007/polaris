/**
 * The store behind an MLS member the server itself runs: Polar as a leaf and
 * the webhook and automation service members (docs/chat-e2ee-proposal.md,
 * section 7). People's devices never come here; their state stays in their own
 * IndexedDB (`@polaris/core-rs/mls-store`).
 *
 * The member runs over in-memory storage; after each operation the caller
 * passes `member.storeChanges()` to `commitMlsStore`, which writes the whole
 * list in ONE database transaction. A process that dies before it commits
 * restarts as if the operation never happened, so nothing the operation
 * produced may be sent before the commit resolves
 * (crates/polaris-core/src/mls/journal.rs). A failed commit is the same as a
 * crash: drop the member and restore it from `loadMlsStore`.
 *
 * The values hold signature and epoch secrets, so each is sealed with
 * `encryptSecret` under POLARIS_MASTER_KEY. The keys name groups and public
 * keys only and stay readable, which is what makes them the primary key.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";

const MAX_DEVICE_LENGTH = 200;

/** One key's change from `MlsMember.storeChanges()`; no value means deleted. */
export interface MlsStoreChange {
    key: Uint8Array;
    value?: Uint8Array | null;
}

/** The arguments `MlsMember.restore` takes for a device's storage. */
export interface MlsStoreSnapshot {
    keys: Uint8Array[];
    values: Uint8Array[];
}

function checkDevice(device: string): void {
    if (typeof device !== "string" || !device.trim() || device.length > MAX_DEVICE_LENGTH)
        throw new TypeError(`the device id must be a non-empty string of at most ${MAX_DEVICE_LENGTH} characters`);
}

/**
 * A device's whole storage. Unbounded on purpose: a member is restored from
 * all of it or not at all, and its size is the member's group state (about
 * 1 MB at 1,000 members, per the proposal's phase 0).
 */
export async function loadMlsStore(device: string): Promise<MlsStoreSnapshot> {
    checkDevice(device);
    const masterKey = loadEnv().POLARIS_MASTER_KEY;
    const rows = await prisma.mlsStoreEntry.findMany({
        where: { device },
        select: { key: true, ciphertext: true, nonce: true, keyId: true }
    });
    // A row sealed under a replaced master key throws CredentialDecryptError:
    // the member cannot be restored and has to join its groups again.
    return {
        keys: rows.map((row) => new Uint8Array(row.key)),
        values: rows.map(
            (row) =>
                new Uint8Array(
                    Buffer.from(
                        decryptSecret(
                            { ciphertext: Buffer.from(row.ciphertext), nonce: Buffer.from(row.nonce), keyId: row.keyId },
                            masterKey
                        ),
                        "base64"
                    )
                )
        )
    };
}

/** Write one operation's changes, all or nothing. */
export async function commitMlsStore(device: string, changes: readonly MlsStoreChange[]): Promise<void> {
    checkDevice(device);
    if (!changes.length) return;
    const masterKey = loadEnv().POLARIS_MASTER_KEY;
    // The last change to a key wins, so a list that names a key twice still
    // fits one delete and one insert per key.
    const latest = new Map<string, MlsStoreChange>();
    for (const change of changes) latest.set(Buffer.from(change.key).toString("base64"), change);
    const touched = [...latest.values()];
    const written = touched.filter((change) => change.value != null);
    await prisma.$transaction([
        prisma.mlsStoreEntry.deleteMany({
            where: { device, key: { in: touched.map((change) => Buffer.from(change.key)) } }
        }),
        prisma.mlsStoreEntry.createMany({
            data: written.map((change) => {
                const blob = encryptSecret(Buffer.from(change.value as Uint8Array).toString("base64"), masterKey);
                return {
                    device,
                    key: Buffer.from(change.key),
                    ciphertext: blob.ciphertext,
                    nonce: blob.nonce,
                    keyId: blob.keyId
                };
            })
        })
    ]);
}

/** Forget a device's storage: the service member is gone from every group. */
export async function destroyMlsStore(device: string): Promise<void> {
    checkDevice(device);
    await prisma.mlsStoreEntry.deleteMany({ where: { device } });
}
