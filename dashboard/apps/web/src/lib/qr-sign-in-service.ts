/**
 * Signing in by scanning the code on the sign-in screen.
 *
 * Three parties meet here. The sign-in screen opens a code and waits on it. A
 * phone that is already signed in scans it, is told what is asking, and answers
 * with the quick-unlock PIN. The waiting screen's next poll spends the approval
 * and comes back holding a session.
 *
 * What makes it safe is not the code - that is on display in whatever room the
 * screen is in - but the two things the person answering must have: a session
 * that is already trusted, and the PIN. It is the same bar as allowing a waiting
 * sign-in from Account > Sessions, and deliberately so; this only removes the
 * step where somebody has to go and find that screen.
 *
 * No second-factor challenge follows, and that is not a hole: an authenticator
 * code proves the person has the phone, while this proves they have the phone AND
 * a session on it AND the PIN. An account with the authenticator armed is treated
 * the same way when it allows a waiting sign-in from Account > Sessions.
 *
 * The session the exchange issues is left to the ordinary guard: the account's
 * network rules are evaluated on its first request like any other sign-in. The
 * one thing it is spared is the "approve new sign-ins" gate, which it has just
 * satisfied in person - a pass is left behind for that, bound to the address that
 * asked and good once.
 */

import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { resolveGeo } from "@/lib/geo-service";
import { cookies, headers } from "next/headers";
import { recordAudit } from "@/lib/audit-service";
import { appBaseUrl } from "@/lib/domain-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientHost, clientIp, clientUserAgent } from "@/lib/request-context";
import { describeDevice, QR_SIGN_IN_PATH, type QrSignInDecision } from "@polaris/core";
import {
    beginSessionRotation,
    claimDeviceCode,
    decideDeviceCode,
    exchangeDeviceCode,
    getUserSecurity,
    openDeviceCode,
    verifyQuickPin
} from "@polaris/auth";

/** How many codes one address may open before it is asked to slow down. Loose
 *  enough for a household behind one address reloading the sign-in screen,
 *  tight enough that nobody fills the table from outside. */
const OPEN_LIMIT = 30;
const OPEN_WINDOW_MS = 10 * 60 * 1000;

/** Guess-throttling for the PIN, matching the one on Account > Sessions: it is
 *  the same short secret standing in front of the same decision. */
const APPROVAL_LIMIT = 5;
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/** What the sign-in screen needs to show a code and wait on it. */
export interface QrSignInCode {
    /** Encoded in the QR. Opens the answering screen with the code filled in. */
    readonly url: string;
    /** Shown under the QR, for a phone that cannot reach the address in the link. */
    readonly userCode: string;
    /** The waiting screen's own secret, sent back on every poll. */
    readonly deviceCode: string;
    readonly expiresAt: string;
    readonly pollMs: number;
}

/** Where a waiting code stands, as the sign-in screen sees it. */
export type QrSignInStatus = "pending" | "approved" | "denied" | "expired";

/** A scanned code as the person answering it is shown it. */
export interface QrSignInRequest {
    readonly userCode: string;
    /** The browser asking, from its user-agent. A label, never a decision. */
    readonly device: string;
    /** Address and country, when they were recorded, on their own: the device
     *  has its own line here, unlike the one-line origin a notification carries. */
    readonly origin: string;
    /** Which of this deployment's names the sign-in screen was opened on. */
    readonly host: string | null;
    readonly requestedAt: string;
    readonly expiresAt: string;
}

/**
 * Open a code for a sign-in screen. Throttled per address: opening one is
 * unauthenticated by nature - nobody has said who they are yet - so it is the
 * one step that a stranger can reach at all.
 */
export async function openSignInCode(): Promise<{ code?: QrSignInCode; error?: string }> {
    const ip = await clientIp();
    const throttle = await rateLimit(`qr-signin:${ip ?? "unknown"}`, OPEN_LIMIT, OPEN_WINDOW_MS);
    if (!throttle.ok) return { error: "Too many codes from here. Sign in with your password." };

    // A code nobody came back for is dead weight the moment it expires, and codes
    // are opened far more often than they are answered. Clearing them here keeps
    // the table bounded without a scheduled job that would exist for this alone.
    await prisma.deviceCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const issued = await openDeviceCode(auth);
    const [userAgent, host] = await Promise.all([clientUserAgent(), clientHost()]);
    // Recorded against the code rather than passed through it: what the person
    // approving is shown has to come from the request that opened the code, not
    // from anything the screen could put in the link.
    await prisma.deviceCode.update({
        where: { deviceCode: issued.deviceCode },
        data: { requestIp: ip ?? null, requestUserAgent: userAgent ?? null, requestHost: host ?? null }
    });

    const base = await appBaseUrl();
    return {
        code: {
            url: `${base}${QR_SIGN_IN_PATH}?code=${encodeURIComponent(issued.userCode)}`,
            userCode: issued.userCode,
            deviceCode: issued.deviceCode,
            expiresAt: issued.expiresAt.toISOString(),
            pollMs: issued.pollIntervalMs
        }
    };
}

/**
 * Ask whether a waiting code has been answered, and sign the browser in when it
 * has. The session cookies are set on this response, so the caller only has to
 * navigate once this reports back approved.
 */
export async function redeemSignInCode(deviceCode: string): Promise<QrSignInStatus> {
    // Read before the exchange: it consumes the row, and the pass below has to be
    // left for the right account before the session that spends it exists.
    const waiting = await prisma.deviceCode.findUnique({
        where: { deviceCode },
        select: { userId: true, status: true }
    });
    if (!waiting) return "expired";
    if (waiting.status === "approved" && waiting.userId) {
        await beginSessionRotation(waiting.userId, (await clientIp()) ?? null);
    }

    const exchange = await exchangeDeviceCode(auth, deviceCode, await headers());
    if (exchange.status !== "approved") return exchange.status;

    const store = await cookies();
    for (const cookie of exchange.cookies) store.set(cookie.name, cookie.value, cookie.options);
    return "approved";
}

/**
 * The waiting sign-in behind a scanned code, for the person deciding on it.
 * Returns null when there is nothing to decide - unknown, expired, already
 * answered, or claimed by another account - which are one answer on purpose: the
 * code is a short string somebody could have typed at a guess.
 */
export async function describeSignInCode(userCode: string, userId: string): Promise<QrSignInRequest | null> {
    const row = await prisma.deviceCode.findUnique({
        where: { userCode },
        select: {
            userCode: true,
            userId: true,
            status: true,
            expiresAt: true,
            createdAt: true,
            requestIp: true,
            requestUserAgent: true,
            requestHost: true
        }
    });
    if (!row || row.status !== "pending" || row.expiresAt <= new Date()) return null;
    if (row.userId && row.userId !== userId) return null;
    // Where the sign-in is coming from is most of what this decision rests on, so
    // the address is resolved to a country here rather than shown as digits.
    const country = row.requestIp ? (await resolveGeo(row.requestIp)).countryCode : null;
    return {
        userCode: row.userCode,
        device: describeDevice(row.requestUserAgent),
        origin: [row.requestIp, country].filter(Boolean).join(" - ") || "Unknown",
        host: row.requestHost,
        requestedAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/**
 * Answer a scanned code.
 *
 * Letting somebody in is the direction that needs proof, so it costs the
 * quick-unlock PIN - an unlocked dashboard someone walked up to must not be
 * enough to sign in a device they are holding. Refusing is free: it only ever
 * closes a door.
 */
export async function decideSignInCode(
    userId: string,
    decision: QrSignInDecision
): Promise<{ error?: string }> {
    const request = await describeSignInCode(decision.userCode, userId);
    if (!request) return { error: "That code is no longer valid. Ask for a new one on the sign-in screen." };

    if (decision.approve) {
        const throttle = await rateLimit(`qr-approval:${userId}`, APPROVAL_LIMIT, APPROVAL_WINDOW_MS);
        if (!throttle.ok) {
            return { error: `Too many attempts. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
        }
        if (!(await getUserSecurity(userId)).hasPin) {
            return { error: "Set a quick unlock PIN in Account > Security before allowing a sign-in this way." };
        }
        if (!(await verifyQuickPin(auth, userId, decision.pin))) return { error: "That PIN is not right." };
    }

    const store = await headers();
    if (!(await claimDeviceCode(auth, decision.userCode, store))) {
        return { error: "That code is no longer valid. Ask for a new one on the sign-in screen." };
    }
    const result = await decideDeviceCode(auth, decision.userCode, decision.approve, store);
    if (result.error) return result;

    await recordAudit({
        actorId: userId,
        action: decision.approve ? "account.signin.qr-approved" : "account.signin.qr-denied",
        targetType: "device-code",
        targetId: decision.userCode,
        metadata: { device: request.device, origin: request.origin }
    });
    return {};
}
