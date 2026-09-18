/**
 * The browser extension's connection to an account, from asking to being cut off.
 *
 * **Why the extension asks for this before anything else.** It used to start at
 * the vault: the first thing it did was ask to be let into one, and everything it
 * held was a vault credential. That made "connected to Polaris" mean "signed in
 * to a vault", so an account with no vault had nothing to connect, and ending the
 * extension's access meant hunting through a vault's client list. The extension
 * is the product's window in the toolbar rather than one feature of it, so what
 * it asks for first is a connection to the ACCOUNT, and a vault is something that
 * connection may then be used for.
 *
 * **The shape is the device-authorization one**, the same as the vault's own
 * sign-in: the extension opens a request, shows a short code, and Polaris - in a
 * browser that is already signed in - approves it. Nothing the extension holds is
 * worth anything until then, and what it is handed afterwards is one bearer token
 * this table stores only the hash of.
 *
 * **Cutting it off is one row.** Every request the extension makes presents that
 * token and is checked here, so ending a connection from the Sessions screen
 * stops the next one, wherever that browser is. It also revokes the vault tokens
 * of any client that connection let in, because a connection that is cut off must
 * not leave a vault open behind it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { describeClient } from "@polaris/core";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { AUTHORIZATION_POLL_MS, AUTHORIZATION_TTL_MS, newUserCode } from "@/lib/device-code";

/** What the extension is handed when it asks. */
export interface OpenedConnection {
    readonly userCode: string;
    /** The extension's own secret, sent back on every poll. Never stored as-is. */
    readonly deviceCode: string;
    readonly expiresAt: Date;
    readonly pollMs: number;
}

/** What an extension says about itself when it asks, and what the request looked
 *  like. The second half is read off the request, never out of its body. */
export interface ConnectionRequest {
    /** The extension's own id for this install. Its claim, never verified. */
    readonly deviceId: string;
    readonly deviceName: string;
    readonly requestIp: string | null;
    readonly requestUserAgent: string | null;
    readonly requestHost: string | null;
}

/** A waiting request, as the person deciding on it is shown it. */
export interface PendingConnection {
    readonly userCode: string;
    /** What the extension called itself. A label, never a decision. */
    readonly device: string;
    /** What the request itself said, which is what the decision rests on. */
    readonly browser: string;
    readonly os: string;
    readonly requestIp: string | null;
    readonly host: string | null;
    readonly requestedAt: string;
    readonly expiresAt: string;
}

/** A connection, as its owner sees it on the Sessions screen. */
export interface ExtensionSessionView {
    readonly id: string;
    readonly name: string;
    readonly browser: string;
    readonly os: string;
    readonly ip: string | null;
    readonly host: string | null;
    readonly createdAt: string;
    readonly lastSeenAt: string;
    /** How many vault clients this connection let in, so ending it says what
     *  else it takes with it. */
    readonly vaultClients: number;
}

/** The connection behind a token on a request. */
export interface ExtensionPrincipal {
    readonly id: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly name: string;
}

/** Whether a thrown Prisma error is a unique-constraint violation (P2002) - here,
 *  a short code another opener wrote first. */
function isUniqueViolation(caught: unknown): boolean {
    return (
        typeof caught === "object" &&
        caught !== null &&
        (caught as { code?: string }).code === "P2002"
    );
}

/**
 * Open a request.
 *
 * Unauthenticated by nature - nobody has said who they are yet - so the caller
 * rate-limits it, and what comes back is useless until somebody signed in to
 * Polaris approves it. Null when every code it drew was taken, which is a
 * refusal the caller passes on rather than an exception the extension cannot act
 * on.
 */
export async function openExtensionConnection(
    input: ConnectionRequest,
    random: (size: number) => Uint8Array,
    now = new Date()
): Promise<OpenedConnection | null> {
    // Requests nobody came back for are dead weight the moment they expire, and
    // these are opened far more often than they are answered.
    await prisma.extensionAuthorization.deleteMany({ where: { expiresAt: { lt: now } } });

    const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_MS);
    const deviceCode = `${generateToken()}${generateToken()}`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const userCode = newUserCode(random);
        try {
            await prisma.extensionAuthorization.create({
                data: {
                    codeHash: hashToken(deviceCode),
                    userCode,
                    status: "pending",
                    deviceId: input.deviceId,
                    deviceName: input.deviceName,
                    requestIp: input.requestIp,
                    requestUserAgent: input.requestUserAgent,
                    requestHost: input.requestHost,
                    expiresAt
                }
            });
            return { userCode, deviceCode, expiresAt, pollMs: AUTHORIZATION_POLL_MS };
        } catch (caught) {
            // A taken code is a row somebody else is waiting on: draw another
            // rather than hand back a code that is not this request's.
            if (!isUniqueViolation(caught)) throw caught;
        }
    }
    return null;
}

/** The request behind a code, or null for anything that cannot be answered -
 *  unknown, expired and already answered are one answer, because the code is
 *  short enough to guess at. */
export async function describeExtensionConnection(
    userCode: string,
    now = new Date()
): Promise<PendingConnection | null> {
    const row = await prisma.extensionAuthorization.findUnique({ where: { userCode } });
    if (!row || row.status !== "pending" || row.expiresAt <= now) return null;
    const client = describeClient(row.requestUserAgent);
    return {
        userCode: row.userCode,
        device: row.deviceName,
        browser: client.browser,
        os: client.os,
        requestIp: row.requestIp,
        host: row.requestHost,
        requestedAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/** Let it in, or turn it away. The row is answered in place; the connection
 *  itself is made when the extension collects it, which is the only moment the
 *  token can be handed over without being stored. */
export async function answerExtensionConnection(input: {
    readonly userId: string;
    readonly userCode: string;
    readonly approve: boolean;
    readonly sessionId: string | null;
}): Promise<{ error?: string }> {
    const answered = await prisma.extensionAuthorization.updateMany({
        where: { userCode: input.userCode, status: "pending", expiresAt: { gt: new Date() } },
        data: {
            status: input.approve ? "approved" : "denied",
            userId: input.userId,
            approvedBySessionId: input.approve ? input.sessionId : null
        }
    });
    if (answered.count === 0) {
        return { error: "Nothing is waiting on that code. Ask the extension for a new one." };
    }
    return {};
}

/** Where a request stands, and the connection when it has been approved. */
export type ClaimedConnection =
    | { readonly status: "pending" | "denied" | "expired" }
    | {
          readonly status: "approved";
          /** Handed over exactly once: the row is spent by the time this returns. */
          readonly token: string;
          readonly account: { readonly id: string; readonly name: string; readonly email: string };
      };

/**
 * Collect an approval and become a connection.
 *
 * The token is minted here rather than at approval, so nothing anywhere holds a
 * usable credential for a request that was never collected. One connection per
 * (account, install): connecting the same browser twice replaces what it held
 * instead of filling the list with rows for one extension.
 */
export async function claimExtensionConnection(
    deviceCode: string,
    seen: {
        readonly ip: string | null;
        readonly userAgent: string | null;
        readonly host: string | null;
    },
    now = new Date()
): Promise<ClaimedConnection> {
    const row = await prisma.extensionAuthorization.findUnique({
        where: { codeHash: hashToken(deviceCode) }
    });
    if (!row) return { status: "expired" };
    if (row.expiresAt <= now) {
        await prisma.extensionAuthorization.deleteMany({ where: { id: row.id } });
        return { status: "expired" };
    }
    if (row.status === "denied") {
        await prisma.extensionAuthorization.deleteMany({ where: { id: row.id } });
        return { status: "denied" };
    }
    if (row.status !== "approved" || !row.userId) return { status: "pending" };

    const account = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { id: true, name: true, email: true, bannedAt: true }
    });
    // Approved by an account that has since been shut: the request dies with it
    // rather than becoming a connection nothing would let through anyway.
    if (!account || account.bannedAt) {
        await prisma.extensionAuthorization.deleteMany({ where: { id: row.id } });
        return { status: "denied" };
    }

    const token = generateToken();
    const client = describeClient(seen.userAgent ?? row.requestUserAgent);
    const session = await prisma.extensionSession.upsert({
        where: { userId_deviceId: { userId: account.id, deviceId: row.deviceId } },
        create: {
            userId: account.id,
            deviceId: row.deviceId,
            name: row.deviceName,
            browser: client.browser,
            os: client.os,
            ip: seen.ip ?? row.requestIp,
            userAgent: seen.userAgent ?? row.requestUserAgent,
            host: seen.host ?? row.requestHost,
            tokenHash: hashToken(token),
            approvedBySessionId: row.approvedBySessionId
        },
        update: {
            name: row.deviceName,
            browser: client.browser,
            os: client.os,
            ip: seen.ip ?? row.requestIp,
            userAgent: seen.userAgent ?? row.requestUserAgent,
            host: seen.host ?? row.requestHost,
            tokenHash: hashToken(token),
            approvedBySessionId: row.approvedBySessionId,
            lastSeenAt: now,
            // A reconnection is this install becoming live again, whatever ended
            // the last one.
            revokedAt: null
        },
        select: { id: true }
    });

    // Anything this install already had a vault open under is adopted by the new
    // connection, which is what makes an extension that was signed in to a vault
    // before connections existed end up managed like every other one.
    await prisma.vaultDevice.updateMany({
        where: { userId: account.id, identifier: row.deviceId },
        data: { extensionSessionId: session.id }
    });

    // Spent: an approval is good for exactly one collection.
    await prisma.extensionAuthorization.deleteMany({ where: { id: row.id } });

    return {
        status: "approved",
        token,
        account: { id: account.id, name: account.name ?? "", email: account.email }
    };
}

/**
 * The connection behind a token, or null when there is none to act for.
 *
 * Revoked, unknown and belonging to a shut account are one answer for the same
 * reason a sign-in refusal is: which of them it was is not the caller's to know.
 * `touch` records that the extension is alive, which is what the Sessions screen
 * reads as "last active".
 */
export async function readExtensionToken(
    token: string | null,
    seen?: {
        readonly ip: string | null;
        readonly userAgent: string | null;
        readonly host: string | null;
    }
): Promise<ExtensionPrincipal | null> {
    if (!token) return null;
    const row = await prisma.extensionSession.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            id: true,
            userId: true,
            deviceId: true,
            name: true,
            revokedAt: true,
            user: { select: { bannedAt: true } }
        }
    });
    if (!row || row.revokedAt || row.user.bannedAt) return null;
    await prisma.extensionSession
        .update({
            where: { id: row.id },
            data: {
                lastSeenAt: new Date(),
                ...(seen?.ip ? { ip: seen.ip } : {}),
                ...(seen?.host ? { host: seen.host } : {})
            }
        })
        .catch(() => undefined);
    return { id: row.id, userId: row.userId, deviceId: row.deviceId, name: row.name };
}

/** Every live connection this account has, most recently active first. */
export async function listExtensionSessions(userId: string): Promise<ExtensionSessionView[]> {
    const rows = await prisma.extensionSession.findMany({
        where: { userId, revokedAt: null },
        orderBy: { lastSeenAt: "desc" },
        select: {
            id: true,
            name: true,
            browser: true,
            os: true,
            ip: true,
            host: true,
            userAgent: true,
            createdAt: true,
            lastSeenAt: true,
            _count: { select: { vaultDevices: true } }
        }
    });
    return rows.map((row) => {
        const client = describeClient(row.userAgent);
        return {
            id: row.id,
            name: row.name,
            browser: row.browser ?? client.browser,
            os: row.os ?? client.os,
            ip: row.ip,
            host: row.host,
            createdAt: row.createdAt.toISOString(),
            lastSeenAt: row.lastSeenAt.toISOString(),
            vaultClients: row._count.vaultDevices
        };
    });
}

/**
 * End one connection.
 *
 * The vault clients it let in go with it: their refresh tokens are revoked, so
 * the next sync fails and the extension drops what it was holding. The device
 * rows stay - they are the vault's own record of what has been signed in - but
 * they are no longer anybody's live client.
 */
export async function revokeExtensionSession(
    userId: string,
    id: string,
    now = new Date()
): Promise<{ revoked: boolean; name: string | null }> {
    const row = await prisma.extensionSession.findFirst({
        where: { id, userId, revokedAt: null },
        select: { id: true, name: true }
    });
    if (!row) return { revoked: false, name: null };

    const devices = await prisma.vaultDevice.findMany({
        where: { extensionSessionId: row.id },
        select: { id: true }
    });
    if (devices.length > 0) {
        await prisma.vaultRefreshToken.updateMany({
            where: { deviceId: { in: devices.map((device) => device.id) }, revokedAt: null },
            data: { revokedAt: now }
        });
    }
    await prisma.extensionSession.update({
        where: { id: row.id },
        // The token goes with the row: a hash nothing can present again is one
        // less way for a revoked connection to come back.
        data: { revokedAt: now, tokenHash: `revoked:${row.id}` }
    });
    return { revoked: true, name: row.name };
}

/** End the connection presenting this token - the extension disconnecting
 *  itself, which needs no session and proves itself with what it holds. */
export async function revokeExtensionToken(token: string): Promise<boolean> {
    const principal = await readExtensionToken(token);
    if (!principal) return false;
    const ended = await revokeExtensionSession(principal.userId, principal.id);
    return ended.revoked;
}
