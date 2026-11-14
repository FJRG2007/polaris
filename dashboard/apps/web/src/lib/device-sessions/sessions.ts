/**
 * A device's sign-in - the command line, a Stream Deck, a TV - as a session.
 *
 * **One source of truth: the API key.** Each of them signs in through the
 * device-code flow and is handed an API key of its own kind (the registry in
 * `./kinds`), and that row is what a request is checked against, so it is also what
 * the sessions screen lists. There is no second table that could say a sign-in
 * is live after its key was revoked, or the other way round: ending it from the
 * sessions screen, from the API keys screen or with `plr logout` is the same
 * write to the same row, and both screens read it back.
 *
 * **It answers to the controls a session does.** It is listed on the account's
 * own sessions screen and an administrator's view of the account, it can be
 * signed out from either, signing out everywhere ends it, closing the account
 * or an administrator ending its sessions ends it, and it can be tied to the
 * address it was last used from - by its own row or by the account's rule - and
 * is ended when it turns up from somewhere else, the way a session is.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { notifySessionsClosed } from "@/lib/notifications/session-events";
import { addressPinned, isHandheld, type AddressPinScope } from "@polaris/core";
import {
    DEVICE_KINDS,
    DEVICE_SESSION_KINDS,
    type DeviceSessionKind
} from "@/lib/device-sessions/kinds";

/** A device's sign-in, as a row on a sessions screen. */
export interface DeviceSessionView {
    /** The API key's id: ending the session revokes this key. */
    readonly id: string;
    /** Which app signed in. */
    readonly kind: DeviceSessionKind;
    /** The device's name, as the app reported it at sign-in. */
    readonly name: string;
    /** The computer's hostname, for a kind whose reported name is one, so the
     *  sessions screen can name the machine its other rows run on. */
    readonly hostname: string | null;
    readonly os: string;
    readonly version: string | null;
    /** The address the sign-in was approved from. */
    readonly signedInIp: string | null;
    /** When it was approved. */
    readonly createdAt: string;
    /** Last use, recorded at most once a minute (and at once on a new address). */
    readonly lastUsedAt: string | null;
    readonly lastUsedIp: string | null;
    readonly expiresAt: string | null;
    /** This sign-in's own answer to the address lock, or null for the account's rule. */
    readonly pinToAddress: boolean | null;
    /** What the account's rule says for it, which is what null means. */
    readonly pinnedByRule: boolean;
}

/** Live: a device kind, not revoked, not expired. */
function liveWhere(userId: string, now: Date) {
    return {
        userId,
        kind: { in: DEVICE_KINDS },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    };
}

/** Whether a sign-in is tied to its address: its own answer where it gave one,
 *  the account's rule where it did not - the rule's own function, so "computers
 *  only" means the same thing for a terminal as for a browser. */
export function devicePinned(
    row: { readonly os: string | null; readonly pinToAddress: boolean | null },
    scope: string | null | undefined
): boolean {
    const os = row.os ?? "Unknown OS"; // i18n-ignore the parser's own word for it
    return addressPinned(
        {
            bindClient: false,
            pinScope: (scope ?? "off") as AddressPinScope,
            pinThisSession: row.pinToAddress
        },
        { os, browser: "", ip: null, handheld: isHandheld(os) }
    );
}

/** Every live device sign-in an account has, most recently used first. */
export async function listDeviceSessions(
    userId: string,
    now = new Date()
): Promise<DeviceSessionView[]> {
    const [security, rows] = await Promise.all([
        prisma.userSecurity.findUnique({
            where: { userId },
            select: { pinSessionsToAddress: true }
        }),
        prisma.apiKey.findMany({
            where: liveWhere(userId, now),
            orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
            take: 200,
            select: {
                id: true,
                kind: true,
                name: true,
                clientName: true,
                clientOs: true,
                clientVersion: true,
                signedInIp: true,
                createdAt: true,
                lastUsedAt: true,
                lastUsedIp: true,
                expiresAt: true,
                pinToAddress: true
            }
        })
    ]);
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind as DeviceSessionKind,
        // A sign-in made before the computer was recorded still has the key's
        // own name, which carries it ("CLI - laptop").
        name: row.clientName ?? row.name,
        hostname: DEVICE_SESSION_KINDS[row.kind as DeviceSessionKind].namesMachine
            ? row.clientName
            : null,
        os: row.clientOs ?? "Unknown OS", // i18n-ignore the parser's own word for it
        version: row.clientVersion,
        signedInIp: row.signedInIp,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        lastUsedIp: row.lastUsedIp,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        pinToAddress: row.pinToAddress,
        pinnedByRule: devicePinned(
            { os: row.clientOs, pinToAddress: null },
            security?.pinSessionsToAddress
        )
    }));
}

/** Sign one out. Scoped to the owner and to device keys, so an id from another
 *  account, or of a key made for something else, changes nothing. */
export async function revokeDeviceSession(
    userId: string,
    id: string,
    now = new Date()
): Promise<boolean> {
    const ended = await prisma.apiKey.updateMany({
        where: { id, userId, kind: { in: DEVICE_KINDS }, revokedAt: null },
        data: { revokedAt: now }
    });
    return ended.count > 0;
}

/** Sign every one out. What signing out everywhere, closing the account and an
 *  administrator ending its sessions call. Returns how many were live. */
export async function revokeAllDeviceSessions(userId: string, now = new Date()): Promise<number> {
    const ended = await prisma.apiKey.updateMany({
        where: liveWhere(userId, now),
        data: { revokedAt: now }
    });
    return ended.count;
}

/** Tie one to its address, untie it, or hand it back to the account's rule. */
export async function pinDeviceSession(
    userId: string,
    id: string,
    pinned: boolean | null
): Promise<boolean> {
    const written = await prisma.apiKey.updateMany({
        where: { id, userId, kind: { in: DEVICE_KINDS }, revokedAt: null },
        data: { pinToAddress: pinned }
    });
    return written.count > 0;
}

/**
 * The address lock, checked when a device's key authenticates: a sign-in tied to its
 * address that turns up from a different one is signed out on the spot, logged,
 * and its owner told - exactly what happens to a session. Returns whether the
 * request may go on.
 *
 * Only an address it was seen at counts as a move: a key never used yet, or a
 * request with no address, has nothing to compare.
 */
export async function deviceAddressAllows(
    key: {
        readonly id: string;
        readonly userId: string;
        readonly lastUsedIp: string | null;
        readonly pinToAddress: boolean | null;
        readonly clientOs: string | null;
    },
    ip: string | undefined
): Promise<boolean> {
    if (!ip || !key.lastUsedIp || ip === key.lastUsedIp) return true;
    const security = await prisma.userSecurity.findUnique({
        where: { userId: key.userId },
        select: { pinSessionsToAddress: true }
    });
    if (
        !devicePinned(
            { os: key.clientOs, pinToAddress: key.pinToAddress },
            security?.pinSessionsToAddress
        )
    )
        return true;

    await revokeDeviceSession(key.userId, key.id);
    await recordAudit({
        actorId: key.userId,
        // The action name predates the other devices; renaming it would split
        // the history the log already holds.
        action: "account.cli.compromised",
        targetType: "apiKey",
        targetId: key.id,
        metadata: { from: key.lastUsedIp, to: ip }
    });
    await notifySessionsClosed({
        userId: key.userId,
        count: 1,
        reason: "A signed-in device was used from a different network address than the one it is locked to, so it was signed out."
    });
    return false;
}
