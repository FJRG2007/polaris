/**
 * What the server keeps about an account key: its two public halves and the
 * envelopes that seal it under each lock. All of it is opaque here - there is
 * no key on the server that opens any envelope - and every read and write is
 * scoped to the signed-in account by the caller.
 *
 * The password envelope is the one that is never simply read: it is handed out
 * only by a successful OPAQUE finish (sign-in, adoption verify or unlock), and
 * only written there too, alongside the proof, so a stolen session cookie gets
 * nothing to guess passwords against offline and cannot plant a bad envelope.
 */

import { prisma, Prisma } from "@polaris/db";

export const PASSWORD_LOCK_ID = "password";

export interface AccountKeyState {
    readonly akVersion: number;
    readonly signPublicKey: Uint8Array;
    readonly hpkePublicKey: Uint8Array;
    readonly passkeyLocks: ReadonlyArray<{ lockId: string; akVersion: number; envelope: Uint8Array }>;
    readonly hasPasswordLock: boolean;
}

export async function accountKeyState(userId: string): Promise<AccountKeyState | null> {
    const [key, locks] = await Promise.all([
        prisma.chatAccountKey.findUnique({
            where: { userId },
            select: { akVersion: true, signPublicKey: true, hpkePublicKey: true }
        }),
        prisma.chatAccountKeyLock.findMany({
            where: { userId },
            select: { kind: true, lockId: true, akVersion: true, envelope: true },
            orderBy: { createdAt: "asc" },
            take: 64
        })
    ]);
    if (!key) return null;
    return {
        akVersion: key.akVersion,
        signPublicKey: key.signPublicKey,
        hpkePublicKey: key.hpkePublicKey,
        passkeyLocks: locks
            .filter((lock) => lock.kind === "passkey-prf")
            .map((lock) => ({ lockId: lock.lockId, akVersion: lock.akVersion, envelope: lock.envelope })),
        hasPasswordLock: locks.some((lock) => lock.kind === "password")
    };
}

/** Publish an account's first key. Refused when it already has one: replacing
 *  it is a rotation, which needs every lock re-sealed and is a later phase. */
export async function createAccountKey(
    userId: string,
    input: { akVersion: number; signPublicKey: Uint8Array; hpkePublicKey: Uint8Array }
): Promise<boolean> {
    try {
        await prisma.chatAccountKey.create({
            data: {
                userId,
                akVersion: input.akVersion,
                signPublicKey: Buffer.from(input.signPublicKey),
                hpkePublicKey: Buffer.from(input.hpkePublicKey)
            }
        });
        return true;
    } catch (caught) {
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002") return false;
        throw caught;
    }
}

/** Store or replace one lock's envelope, for the account's current key version. */
export async function putLock(
    userId: string,
    lock: { kind: "password" | "passkey-prf"; lockId: string; akVersion: number; envelope: Uint8Array }
): Promise<boolean> {
    const key = await prisma.chatAccountKey.findUnique({ where: { userId }, select: { akVersion: true } });
    if (!key || key.akVersion !== lock.akVersion) return false;
    const envelope = Buffer.from(lock.envelope);
    await prisma.chatAccountKeyLock.upsert({
        where: { userId_kind_lockId: { userId, kind: lock.kind, lockId: lock.lockId } },
        create: { userId, kind: lock.kind, lockId: lock.lockId, akVersion: lock.akVersion, envelope },
        update: { akVersion: lock.akVersion, envelope }
    });
    return true;
}

export async function deletePasskeyLock(userId: string, lockId: string): Promise<void> {
    await prisma.chatAccountKeyLock.deleteMany({ where: { userId, kind: "passkey-prf", lockId } });
}

/** The password envelope, for the caller of a successful OPAQUE finish only. */
export async function passwordEnvelope(
    userId: string
): Promise<{ akVersion: number; envelope: Uint8Array } | null> {
    const row = await prisma.chatAccountKeyLock.findUnique({
        where: { userId_kind_lockId: { userId, kind: "password", lockId: PASSWORD_LOCK_ID } },
        select: { akVersion: true, envelope: true }
    });
    return row ? { akVersion: row.akVersion, envelope: row.envelope } : null;
}
