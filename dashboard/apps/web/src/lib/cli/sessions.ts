/**
 * A CLI sign-in as a session.
 *
 * **One source of truth: the API key.** A `plr login` is an API key of kind
 * "cli", and that row is what a request is checked against, so it is also what
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

/** A CLI sign-in, as a row on a sessions screen. */
export interface CliSessionView {
    /** The API key's id: ending the session revokes this key. */
    readonly id: string;
    /** The computer's name, as the CLI reported it at sign-in. */
    readonly name: string;
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

/** Live: kind "cli", not revoked, not expired. */
function liveWhere(userId: string, now: Date) {
    return {
        userId,
        kind: "cli",
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    };
}

/** Whether a sign-in is tied to its address: its own answer where it gave one,
 *  the account's rule where it did not - the rule's own function, so "computers
 *  only" means the same thing for a terminal as for a browser. */
export function cliPinned(
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

/** Every live CLI sign-in an account has, most recently used first. */
export async function listCliSessions(userId: string, now = new Date()): Promise<CliSessionView[]> {
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
        // A sign-in made before the computer was recorded still has the key's
        // own name, which carries it ("CLI - laptop").
        name: row.clientName ?? row.name,
        os: row.clientOs ?? "Unknown OS", // i18n-ignore the parser's own word for it
        version: row.clientVersion,
        signedInIp: row.signedInIp,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        lastUsedIp: row.lastUsedIp,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        pinToAddress: row.pinToAddress,
        pinnedByRule: cliPinned(
            { os: row.clientOs, pinToAddress: null },
            security?.pinSessionsToAddress
        )
    }));
}

/** Sign one out. Scoped to the owner and to CLI keys, so an id from another
 *  account, or of a key made for something else, changes nothing. */
export async function revokeCliSession(
    userId: string,
    id: string,
    now = new Date()
): Promise<boolean> {
    const ended = await prisma.apiKey.updateMany({
        where: { id, userId, kind: "cli", revokedAt: null },
        data: { revokedAt: now }
    });
    return ended.count > 0;
}

/** Sign every one out. What signing out everywhere, closing the account and an
 *  administrator ending its sessions call. Returns how many were live. */
export async function revokeCliSessions(userId: string, now = new Date()): Promise<number> {
    const ended = await prisma.apiKey.updateMany({
        where: liveWhere(userId, now),
        data: { revokedAt: now }
    });
    return ended.count;
}

/** Tie one to its address, untie it, or hand it back to the account's rule. */
export async function pinCliSession(
    userId: string,
    id: string,
    pinned: boolean | null
): Promise<boolean> {
    const written = await prisma.apiKey.updateMany({
        where: { id, userId, kind: "cli", revokedAt: null },
        data: { pinToAddress: pinned }
    });
    return written.count > 0;
}

/**
 * The address lock, checked when a CLI key authenticates: a sign-in tied to its
 * address that turns up from a different one is signed out on the spot, logged,
 * and its owner told - exactly what happens to a session. Returns whether the
 * request may go on.
 *
 * Only an address it was seen at counts as a move: a key never used yet, or a
 * request with no address, has nothing to compare.
 */
export async function cliAddressAllows(
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
        !cliPinned(
            { os: key.clientOs, pinToAddress: key.pinToAddress },
            security?.pinSessionsToAddress
        )
    )
        return true;

    await revokeCliSession(key.userId, key.id);
    await recordAudit({
        actorId: key.userId,
        action: "account.cli.compromised",
        targetType: "apiKey",
        targetId: key.id,
        metadata: { from: key.lastUsedIp, to: ip }
    });
    await notifySessionsClosed({
        userId: key.userId,
        count: 1,
        reason: "A command-line sign-in was used from a different network address than the one it is locked to, so it was signed out."
    });
    return false;
}
