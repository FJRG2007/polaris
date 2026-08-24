"use server";

/**
 * Session-management actions. Each re-resolves the session, so the ids a client
 * sends are only ever matched against the caller's own sessions - a forged id
 * belonging to another account simply matches nothing.
 *
 * Everything that reaches another device passes the new-device gate first, when
 * the account has asked for one. Signing the account's other devices out is the
 * move that removes the witnesses, and it is worth the most to somebody who has
 * just arrived with a password they should not have. Reading the lists, and
 * signing out the browser in hand, are never gated: the first changes nothing and
 * the second only ever closes a door on itself.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { sessionName } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import { revokeTrustedDevice, revokeTrustedDevices } from "@polaris/auth";
import { notifySessionsClosed } from "@/lib/notifications/session-events";
import {
    decideLoginApproval,
    revokeDeviceSessions,
    revokeOtherSessions,
    revokeUserSession,
    trustedDeviceDetail,
    type TrustedDeviceDetail
} from "@/lib/session-directory";

const sessionIdSchema = z.string().uuid();

/** The handle a remembered browser is named by: better-auth's own identifier for
 *  the pass. Shaped rather than free text, so a malformed one is refused here
 *  instead of turning into a query nobody meant to run. */
const trustedDeviceIdSchema = z.string().regex(/^trust-device-[A-Za-z0-9_-]{1,64}$/);

/** Guess-throttling for the PIN that stands between a waiting sign-in and access. */
const APPROVAL_LIMIT = 5;
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Record that this device is signing itself out, immediately before it does.
 *
 * Sign-out itself is better-auth's, driven from the browser, so there is no
 * server step to hang this on - but an account's history is meant to answer
 * "where is this signed in, and when did that stop", and a sign-out that left no
 * trace was the one gap in it. Called while the session is still valid, which is
 * what lets it be attributed at all.
 */
export async function noteSignOutAction(): Promise<void> {
    const user = await requireUser();
    await recordAudit({
        actorId: user.id,
        action: "account.session.signed-out",
        targetType: "session",
        targetId: user.sessionId
    });
    await notifySessionsClosed({
        userId: user.id,
        count: 1,
        reason: `${sessionName(user.sessionId)} signed itself out.`
    });
}

export async function revokeSessionAction(sessionId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: "Unknown session." };
    if (parsed.data === user.sessionId) return { error: "Use Sign out to end this session." };
    await revokeUserSession(user.id, parsed.data);
    revalidatePath("/account/sessions");
    return {};
}

/**
 * Tie one session to its address, untie it, or hand it back to the account's own
 * rule.
 *
 * Three answers rather than two, and the third is the one that matters: "follow
 * the rule" is what nearly every session holds, and without it the account-wide
 * setting would mean nothing the moment somebody touched a single row.
 *
 * No password asked for. Pinning only ever narrows where a session works, and
 * unpinning one narrows nothing that was not already the account's default - the
 * ways in are unchanged either way.
 */
export async function pinSessionAction(
    sessionId: unknown,
    pinned: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: "Unknown session." };
    if (pinned !== null && typeof pinned !== "boolean") return { error: "Unknown setting." };

    // Scoped to the caller's own account, so an id from somewhere else changes
    // nothing rather than reaching another account's session.
    const written = await prisma.sessionState.updateMany({
        where: { sessionId: parsed.data, userId: user.id },
        data: { pinToAddress: pinned }
    });
    if (written.count === 0) return { error: "That session is no longer signed in." };

    await recordAudit({
        actorId: user.id,
        action: "account.session.pinned",
        targetType: "session",
        targetId: parsed.data,
        metadata: { pinToAddress: pinned }
    });
    revalidatePath("/account/sessions");
    return {};
}

export async function revokeOtherSessionsAction(): Promise<{ count: number; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { count: 0, error: blocked };
    const count = await revokeOtherSessions(user.id, user.sessionId);
    revalidatePath("/account/sessions");
    return { count };
}

/**
 * Stop remembering one browser, so its next sign-in answers the challenge again.
 *
 * Scoped to the caller's own account inside revokeTrustedDevice, so a handle
 * lifted from somewhere else matches nothing rather than reaching another
 * account's device.
 *
 * No password is asked for, here or below: this only ever narrows the ways in,
 * and the moment somebody reaches for it is the moment a remembered device is
 * somewhere it should not be. A control that asks for more before it can take
 * access away is a control that arrives too late.
 */
export async function forgetTrustedDeviceAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = trustedDeviceIdSchema.safeParse(id);
    if (!parsed.success) return { error: "That device is no longer remembered." };
    if (!(await revokeTrustedDevice(user.id, parsed.data))) {
        return { error: "That device is no longer remembered." };
    }
    await recordAudit({ actorId: user.id, action: "account.2fa.trusted-device-revoked" });
    revalidatePath("/account/sessions");
    return {};
}

/**
 * Everything the account holds on one remembered device: the pass, the sessions
 * open on it wherever they were opened, and the passkeys it registered.
 *
 * Read on demand rather than with the page, because it is a handful of extra
 * queries for a panel most visits never open.
 */
export async function trustedDeviceAction(
    id: unknown
): Promise<{ detail?: TrustedDeviceDetail; error?: string }> {
    const user = await requireUser();
    const parsed = trustedDeviceIdSchema.safeParse(id);
    if (!parsed.success) return { error: "That device is no longer remembered." };
    const detail = await trustedDeviceDetail(user.id, user.sessionId, parsed.data);
    if (!detail) return { error: "That device is no longer remembered." };
    return { detail };
}

/**
 * Sign one device out of this account everywhere: every session it has open, on
 * every name Polaris answers on.
 *
 * The pass is left alone. Ending the sessions and forgetting the device are two
 * different decisions - a laptop that was borrowed for an afternoon needs the
 * first, one that was stolen needs both - and the panel offers them separately.
 */
export async function signOutTrustedDeviceAction(
    id: unknown
): Promise<{ count?: number; endedCurrent?: boolean; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = trustedDeviceIdSchema.safeParse(id);
    if (!parsed.success) return { error: "That device is no longer remembered." };
    const result = await revokeDeviceSessions(user.id, user.sessionId, parsed.data);
    revalidatePath("/account/sessions");
    return result;
}

/** Stop remembering every browser at once. */
export async function forgetTrustedDevicesAction(): Promise<{ count: number; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { count: 0, error: blocked };
    const count = await revokeTrustedDevices(user.id);
    if (count > 0) {
        await recordAudit({
            actorId: user.id,
            action: "account.2fa.trusted-devices-revoked",
            metadata: { count }
        });
    }
    revalidatePath("/account/sessions");
    return { count };
}

/**
 * Decide a waiting sign-in. Approving asks for the quick-unlock PIN, so the
 * attempts are throttled the way any short secret has to be; refusing is free.
 */
export async function decideLoginApprovalAction(
    sessionId: unknown,
    approve: boolean,
    pin?: string
): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: "Unknown session." };
    if (approve === true) {
        // Letting somebody else in is the one direction that needs the wait;
        // refusing a sign-in is always allowed, from any device.
        const blocked = await newDeviceRefusal(user);
        if (blocked) return { error: blocked };
        const throttle = await rateLimit(`signin-approval:${user.id}`, APPROVAL_LIMIT, APPROVAL_WINDOW_MS);
        if (!throttle.ok) {
            return { error: `Too many attempts. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
        }
    }
    const result = await decideLoginApproval(
        user.id,
        parsed.data,
        approve === true,
        String(pin ?? ""),
        user.sessionId
    );
    if (!result.error) revalidatePath("/account/sessions");
    return result;
}
