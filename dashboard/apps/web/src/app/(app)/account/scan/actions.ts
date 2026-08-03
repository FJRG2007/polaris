"use server";

/**
 * Answering a scanned sign-in code. The decision is re-derived server-side from
 * the caller's own session, so the only thing the client contributes is which
 * code it read and the PIN typed to confirm it.
 */

import { requireUser } from "@/lib/session";
import { qrSignInDecisionSchema } from "@polaris/core";
import { decideSignInCode } from "@/lib/qr-sign-in-service";

export async function decideQrSignInAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = qrSignInDecisionSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not a Polaris sign-in code." };
    return decideSignInCode(user.id, parsed.data);
}
