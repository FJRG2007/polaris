/**
 * Binding a browser extension's connection to the computer it runs on, by
 * proof rather than by address.
 *
 * The extension (already joined to its account by its own token) is issued a
 * nonce here, bound to the account and to that one connection. It hands the
 * nonce to Polaris Desktop through the browser's native messaging, and the
 * desktop presents it over its own signed-in session, whose device key the
 * session guard already holds (`SessionState.deviceKey`). Only then is the
 * connection given that key - and with it a place under that device on the
 * sessions screen, and in what "sign out / block this device" reaches.
 *
 * A nonce lives two minutes, is kept only as a hash, and is deleted by the
 * claim that uses it, so presenting it twice finds nothing. A claim from
 * another account, from a session with no device key, for a connection that
 * has ended, or from a device the account blocked binds nothing.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { PAIRING_NONCE_TTL_MS } from "@polaris/core";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { isDeviceBlocked } from "@/lib/device-sessions/device-key";

/** How many live nonces one connection may hold at once. */
const OPEN_PER_CONNECTION = 3;

/** What the extension is handed when it asks to be paired. */
export type PairingOffer =
    | { readonly paired: true }
    | { readonly paired: false; readonly nonce: string; readonly expiresAt: Date };

/** Why a claim bound nothing. Never shown to anybody but the desktop's log. */
export type PairingRefusal = "unknown" | "expired" | "wrong-account" | "connection-ended" | "no-device-key" | "blocked";

export type PairingClaim = { readonly bound: true } | { readonly bound: false; readonly reason: PairingRefusal };

/**
 * A nonce for this connection, or word that it is already paired.
 *
 * `runtimeId` is the extension's id in its browser, recorded so Polaris Desktop
 * can let exactly that extension talk to its native messaging host.
 */
export async function offerPairing(
    connection: { readonly id: string; readonly userId: string },
    runtimeId: string | null,
    now = new Date()
): Promise<PairingOffer> {
    const row = await prisma.extensionSession.findFirst({
        where: { id: connection.id, userId: connection.userId, revokedAt: null },
        select: { deviceKey: true, runtimeId: true }
    });
    if (!row) throw new Error("The connection is not there.");
    if (runtimeId && runtimeId !== row.runtimeId) {
        await prisma.extensionSession.update({ where: { id: connection.id }, data: { runtimeId } });
    }
    if (row.deviceKey) return { paired: true };

    await prisma.extensionDevicePairing.deleteMany({ where: { expiresAt: { lt: now } } });
    const open = await prisma.extensionDevicePairing.findMany({
        where: { extensionSessionId: connection.id },
        orderBy: { createdAt: "asc" },
        select: { id: true }
    });
    const surplus = open.slice(0, Math.max(0, open.length - (OPEN_PER_CONNECTION - 1)));
    if (surplus.length) {
        await prisma.extensionDevicePairing.deleteMany({ where: { id: { in: surplus.map((item) => item.id) } } });
    }
    const nonce = generateToken();
    const expiresAt = new Date(now.getTime() + PAIRING_NONCE_TTL_MS);
    await prisma.extensionDevicePairing.create({
        data: {
            userId: connection.userId,
            extensionSessionId: connection.id,
            nonceHash: hashToken(nonce),
            expiresAt
        }
    });
    return { paired: false, nonce, expiresAt };
}

/**
 * Present a nonce from a signed-in session and, when it holds, give the
 * connection it was issued to that session's device key.
 *
 * The row is deleted before anything else is judged, and only the claim that
 * deleted it goes on: two presenting at once, or one presenting twice, leave
 * exactly one that could bind.
 */
export async function claimPairing(
    claimant: { readonly userId: string; readonly deviceKey: string | null },
    nonce: string,
    now = new Date()
): Promise<PairingClaim> {
    const row = await prisma.extensionDevicePairing.findUnique({
        where: { nonceHash: hashToken(nonce) },
        select: { id: true, userId: true, extensionSessionId: true, expiresAt: true }
    });
    if (!row) return { bound: false, reason: "unknown" };
    const taken = await prisma.extensionDevicePairing.deleteMany({ where: { id: row.id } });
    if (taken.count !== 1) return { bound: false, reason: "unknown" };
    if (row.expiresAt.getTime() <= now.getTime()) return { bound: false, reason: "expired" };
    if (row.userId !== claimant.userId) return { bound: false, reason: "wrong-account" };
    if (!claimant.deviceKey) return { bound: false, reason: "no-device-key" };
    if (await isDeviceBlocked(claimant.userId, claimant.deviceKey)) return { bound: false, reason: "blocked" };
    const bound = await prisma.extensionSession.updateMany({
        where: { id: row.extensionSessionId, userId: claimant.userId, revokedAt: null },
        data: { deviceKey: claimant.deviceKey }
    });
    if (bound.count !== 1) return { bound: false, reason: "connection-ended" };
    return { bound: true };
}

/** The ids, in their browsers, of this account's live extensions - what the
 *  desktop app writes into its native messaging host's manifest. */
export async function pairingExtensionIds(userId: string): Promise<string[]> {
    const rows = await prisma.extensionSession.findMany({
        where: { userId, revokedAt: null, runtimeId: { not: null } },
        select: { runtimeId: true },
        orderBy: { lastSeenAt: "desc" },
        take: 50
    });
    return [...new Set(rows.map((row) => row.runtimeId).filter((id): id is string => !!id))];
}
