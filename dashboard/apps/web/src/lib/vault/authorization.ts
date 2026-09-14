/**
 * Letting a client into a vault from a browser that is already in it.
 *
 * The extension is what this exists for. Asking somebody to type their master
 * password into a popup is the step that makes an extension feel like a lesser
 * client - the dashboard is open in the next tab, unlocked, holding the key - and
 * it is also the step that teaches people to type that password into small windows
 * they did not open. So: the extension asks, the dashboard approves, and the key
 * arrives wrapped to a public half the extension made for that one exchange.
 *
 * **What Polaris holds while this is in flight.** The extension's public key, a
 * short code, and - once approved - the account's vault key sealed to that public
 * key. The private half never leaves the extension, so the sealed copy is of no use
 * to this server, to its database, or to anybody reading either. That is the same
 * arrangement emergency access uses (`VaultEmergencyAccess.keyEncrypted`), and it
 * is what makes an approval real rather than a flag somebody could set.
 *
 * **What makes it safe** is not the code, which is on screen in whatever room the
 * browser is in, but what the person approving must already have: a Polaris
 * session, and a vault they have unlocked. That is strictly more than the master
 * password alone proves, which is what the extension would otherwise have asked
 * for.
 *
 * Every row here is short-lived and single-use: spent on the first claim, swept
 * when it expires. A request nobody answers is worthless within minutes.
 */

import { prisma } from "@polaris/db";
import { hashToken } from "@polaris/core/tokens";
import {
    AUTHORIZATION_POLL_MS,
    AUTHORIZATION_TTL_MS,
    newUserCode,
    type PendingAuthorization
} from "@/lib/vault/authorization-code";

// What a code IS lives in `authorization-code`, which has no database import -
// the screen that approves one is a client component, and anything it imports is
// bundled for the browser. Re-exported here so a server caller has one import.
export {
    AUTHORIZATION_POLL_MS,
    AUTHORIZATION_TTL_MS,
    formatUserCode,
    newUserCode,
    readUserCode,
    type PendingAuthorization
} from "@/lib/vault/authorization-code";

/** What the extension is handed when it asks. */
export interface OpenedAuthorization {
    /** Shown in the popup and typed into the dashboard. */
    readonly userCode: string;
    /** The extension's own secret, sent back on every poll. Never stored as-is. */
    readonly deviceCode: string;
    readonly expiresAt: Date;
    readonly pollMs: number;
}

/** What a client says about itself when it asks. */
export interface AuthorizationRequest {
    /** The extension's RSA public half, base64. */
    readonly publicKey: string;
    readonly deviceIdentifier: string;
    readonly deviceName: string;
    readonly deviceType: number;
    /** From the request rather than from the client: what the approval screen
     *  shows must not be something the asker could dress up. */
    readonly requestIp: string | null;
    readonly requestUserAgent: string | null;
    readonly requestHost: string | null;
}

/**
 * Open a request. Unauthenticated by nature - nobody has said who they are yet -
 * so the caller rate-limits it, and what comes back is useless until somebody
 * inside the vault approves it.
 */
export async function openVaultAuthorization(
    input: AuthorizationRequest,
    random: (size: number) => Uint8Array,
    now = new Date()
): Promise<OpenedAuthorization> {
    // A request nobody came back for is dead weight the moment it expires, and
    // these are opened far more often than they are answered. Cleared here so the
    // table stays bounded without a scheduled job that would exist for this alone.
    await prisma.vaultAuthorization.deleteMany({ where: { expiresAt: { lt: now } } });

    const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_MS);
    // Two secrets, two jobs: the long one is the extension's proof that the
    // approval is its own, the short one is what a person reads and types.
    const deviceCode =
        crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

    // A collision on the short code is a taken row, not a failure: try again with
    // a fresh one rather than handing back a code somebody else is waiting on.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const userCode = newUserCode(random);
        const taken = await prisma.vaultAuthorization.findUnique({
            where: { userCode },
            select: { id: true }
        });
        if (taken) continue;
        await prisma.vaultAuthorization.create({
            data: {
                codeHash: hashToken(deviceCode),
                userCode,
                publicKey: input.publicKey,
                status: "pending",
                deviceIdentifier: input.deviceIdentifier,
                deviceName: input.deviceName,
                deviceType: input.deviceType,
                requestIp: input.requestIp,
                requestUserAgent: input.requestUserAgent,
                requestHost: input.requestHost,
                expiresAt
            }
        });
        return { userCode, deviceCode, expiresAt, pollMs: AUTHORIZATION_POLL_MS };
    }
    throw new Error("Could not mint a free authorization code");
}

/**
 * The request behind a code, for the account about to decide on it.
 *
 * Null for anything there is nothing to decide about - unknown, expired, or
 * already answered. One answer on purpose: the code is a short string somebody
 * could have typed at a guess, and telling the guesser which of those it was is
 * telling them whether it exists.
 *
 * There is no owner to check against here, and deliberately so: a pending row has
 * no account on it by construction - `userId` is written by the answer - so any
 * signed-in account with `vault.use` may describe a waiting code. What that account
 * can do with it is the sealing, which needs their own unlocked vault.
 */
export async function describeVaultAuthorization(
    userCode: string,
    now = new Date()
): Promise<PendingAuthorization | null> {
    const row = await prisma.vaultAuthorization.findUnique({
        where: { userCode },
        select: {
            userCode: true,
            status: true,
            publicKey: true,
            deviceName: true,
            requestIp: true,
            requestHost: true,
            createdAt: true,
            expiresAt: true
        }
    });
    if (!row || row.status !== "pending" || row.expiresAt <= now) return null;
    return {
        userCode: row.userCode,
        device: row.deviceName,
        requestIp: row.requestIp,
        host: row.requestHost,
        publicKey: row.publicKey,
        requestedAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/**
 * Answer a request.
 *
 * Approving writes the sealed key, which is the whole approval: a row marked
 * approved with nothing sealed into it would be a client that is let in and cannot
 * read anything, which is worse than a refusal because it looks like success.
 * Refusing needs nothing but the decision.
 */
export async function answerVaultAuthorization(
    input: {
        readonly userId: string;
        readonly userCode: string;
        readonly approve: boolean;
        /** The account's vault key, sealed to the request's public half. Required
         *  to approve, ignored on a refusal. */
        readonly wrappedKey?: string;
    },
    now = new Date()
): Promise<{ error?: string }> {
    if (input.approve && !input.wrappedKey) {
        return { error: "Unlock your vault before letting a client in." };
    }
    // Only a pending, unexpired row is answerable, and the update says so in its
    // own where clause: two dashboards answering at once must not both succeed.
    const answered = await prisma.vaultAuthorization.updateMany({
        where: { userCode: input.userCode, status: "pending", expiresAt: { gt: now } },
        data: {
            status: input.approve ? "approved" : "denied",
            userId: input.userId,
            wrappedKey: input.approve ? input.wrappedKey : null
        }
    });
    if (answered.count === 0) {
        return { error: "That code is no longer waiting. Ask the extension for a new one." };
    }
    return {};
}

/** Where a waiting request stands, as the extension sees it. */
export type AuthorizationStatus = "pending" | "approved" | "denied" | "expired";

/** An approval, spent. */
export interface ClaimedAuthorization {
    readonly userId: string;
    /** The vault key sealed to the extension's public half. */
    readonly wrappedKey: string;
    readonly device: { readonly identifier: string; readonly name: string; readonly type: number };
}

/**
 * Spend an approval.
 *
 * Single-use, and the row is gone before a token is minted: an approval that could
 * be claimed twice is a credential anybody who saw the poll could take a copy of.
 * Every other status is reported rather than consumed, because the extension is
 * still waiting on those.
 */
export async function claimVaultAuthorization(
    deviceCode: string,
    now = new Date()
): Promise<{ status: AuthorizationStatus; claimed?: ClaimedAuthorization }> {
    const row = await prisma.vaultAuthorization.findUnique({
        where: { codeHash: hashToken(deviceCode) },
        select: {
            id: true,
            status: true,
            userId: true,
            wrappedKey: true,
            deviceIdentifier: true,
            deviceName: true,
            deviceType: true,
            expiresAt: true
        }
    });
    if (!row) return { status: "expired" };
    if (row.expiresAt <= now) {
        await prisma.vaultAuthorization.deleteMany({ where: { id: row.id } });
        return { status: "expired" };
    }
    if (row.status === "denied") {
        await prisma.vaultAuthorization.deleteMany({ where: { id: row.id } });
        return { status: "denied" };
    }
    if (row.status !== "approved" || !row.userId || !row.wrappedKey) return { status: "pending" };

    // Deleted by id AND status, so the row is spent exactly once even if two polls
    // arrive together: the second finds nothing to delete and is told to keep
    // waiting rather than being handed a second copy of the same credential.
    const spent = await prisma.vaultAuthorization.deleteMany({
        where: { id: row.id, status: "approved" }
    });
    if (spent.count === 0) return { status: "pending" };

    return {
        status: "approved",
        claimed: {
            userId: row.userId,
            wrappedKey: row.wrappedKey,
            device: {
                identifier: row.deviceIdentifier,
                name: row.deviceName,
                type: row.deviceType
            }
        }
    };
}
