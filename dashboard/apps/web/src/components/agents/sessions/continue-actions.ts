"use server";

/**
 * The computer's side of "Continue on phone": open the one-time link for a
 * session, and watch it for a signed-out phone waiting on the PIN. The PIN
 * itself is answered by the QR sign-in's own action (`decideQrSignInAction`).
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { getUserSecurity } from "@polaris/auth";
import * as pairing from "@/lib/agents/session-pairing";
import { describeSignInCode, type QrSignInRequest } from "@/lib/qr-sign-in-service";

const sessionIdSchema = z.string().uuid();
const codeSchema = z.string().regex(pairing.PAIRING_CODE);

export async function openContinueAction(sessionId: unknown): Promise<{ url: string; code: string; expiresAt: string } | { error: "busy" | "denied" }> {
    const user = await requireUser();
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) return { error: "denied" };
    const opened = await pairing.openPairing(user.id, parsed.data);
    if (opened === "busy") return { error: "busy" };
    return opened ?? { error: "denied" };
}

export type ContinueState =
    | { state: "waiting" | "gone" }
    | { state: "phone"; request: QrSignInRequest; hasPin: boolean; pinLength: number | null };

export async function continueStateAction(code: unknown): Promise<ContinueState> {
    const user = await requireUser();
    const parsed = codeSchema.safeParse(code);
    if (!parsed.success) return { state: "gone" };
    const now = await pairing.pairingState(parsed.data, user.id);
    if (now.state !== "phone") return now;
    const request = await describeSignInCode(now.userCode, user.id);
    if (!request) return { state: "gone" };
    const security = await getUserSecurity(user.id);
    return { state: "phone", request, hasPin: security.hasPin, pinLength: security.pinLength ?? null };
}
