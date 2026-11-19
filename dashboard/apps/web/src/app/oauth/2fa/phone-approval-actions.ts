"use server";

/**
 * Asking the account's phone to approve this sign-in, and asking how it went.
 *
 * Both act only on the challenge this browser's own signed cookie names: nothing
 * here accepts an account, so neither can be pointed at somebody else's sign-in.
 * The request is rate limited per account and per challenge (each one buzzes a
 * phone); the poll per challenge.
 */

import { z } from "zod";
import { describeDevice } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientIp, clientUserAgent } from "@/lib/request-context";
import { challengeIdentifier, pendingTwoFactorUserId } from "@/lib/two-factor-challenge";
import {
    collectApproval,
    phoneCanApprove,
    requestApproval,
    type ApprovalState
} from "@/lib/mobile/sign-in-approval";
import { createHash } from "node:crypto";

export type PhoneApprovalRequest = { ok: true; id: string } | { ok: false; reason: "unavailable" | "tooMany" };

const approvalIdSchema = z.string().uuid();

function challengeKey(identifier: string): string {
    return createHash("sha256").update(identifier).digest("hex").slice(0, 32);
}

export async function requestPhoneApprovalAction(): Promise<PhoneApprovalRequest> {
    const [identifier, userId] = await Promise.all([challengeIdentifier(), pendingTwoFactorUserId()]);
    if (!identifier || !userId || !(await phoneCanApprove(userId))) return { ok: false, reason: "unavailable" };
    const [perAccount, perChallenge] = await Promise.all([
        rateLimit(`phone-approval:user:${userId}`, 10, 10 * 60_000),
        rateLimit(`phone-approval:challenge:${challengeKey(identifier)}`, 3, 10 * 60_000)
    ]);
    if (!perAccount.ok || !perChallenge.ok) return { ok: false, reason: "tooMany" };
    const [userAgent, ip] = await Promise.all([clientUserAgent(), clientIp()]);
    const id = await requestApproval({
        userId,
        identifier,
        device: userAgent ? describeDevice(userAgent) : null,
        ip: ip ?? null
    });
    await recordAudit({
        actorId: userId,
        action: "account.phone-approval.requested",
        targetType: "sign-in-approval",
        targetId: id
    });
    return { ok: true, id };
}

export async function phoneApprovalStatusAction(id: unknown): Promise<ApprovalState> {
    const parsed = approvalIdSchema.safeParse(id);
    const identifier = await challengeIdentifier();
    if (!parsed.success || !identifier) return { state: "expired" };
    const allowed = await rateLimit(`phone-approval:poll:${challengeKey(identifier)}`, 90, 60_000);
    if (!allowed.ok) return { state: "pending" };
    return collectApproval(identifier, parsed.data);
}
