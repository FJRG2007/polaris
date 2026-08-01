"use server";

/**
 * The public side of account recovery. Every action here is reachable without a
 * session - that is the point of the route - so each one re-validates its input
 * and leaves the throttling and the disclosure rules to the service, which is
 * where they are reasoned about in one place.
 */

import { clientIp, clientUserAgent } from "@/lib/request-context";
import { recoveryLookupSchema, recoveryRequestSchema, recoveryResetSchema, type AccountRecoveryStatus } from "@polaris/core";
import {
    accountRecoveryQuestions,
    accountRecoveryStatus,
    completeAccountRecovery,
    requestAccountRecovery
} from "@/lib/account-recovery-service";

/** The questions the account set, if it set any and if anyone is asking. */
export async function lookupRecoveryAction(input: unknown): Promise<{ questions: string[]; error?: string }> {
    const parsed = recoveryLookupSchema.safeParse(input);
    if (!parsed.success) return { questions: [], error: parsed.error.issues[0]?.message ?? "Check the form." };
    const result = await accountRecoveryQuestions(parsed.data.identifier, (await clientIp()) ?? null);
    if (result.retryAfterMs > 0) {
        return { questions: [], error: `Too many attempts. Try again in ${Math.ceil(result.retryAfterMs / 60000)} minutes.` };
    }
    return { questions: result.questions };
}

/** Raise the request and hand back the ticket that redeems it once approved. */
export async function requestRecoveryAction(input: unknown): Promise<{ ticket: string; error?: string }> {
    const parsed = recoveryRequestSchema.safeParse(input);
    if (!parsed.success) return { ticket: "", error: parsed.error.issues[0]?.message ?? "Check the form." };
    return requestAccountRecovery({
        identifier: parsed.data.identifier,
        answers: parsed.data.answers,
        ip: (await clientIp()) ?? null,
        userAgent: (await clientUserAgent()) ?? null
    });
}

/** Where the request stands, for the page waiting on a decision. */
export async function recoveryStatusAction(ticket: string): Promise<AccountRecoveryStatus> {
    return accountRecoveryStatus(String(ticket));
}

/** Set the new password on an approved request. */
export async function completeRecoveryAction(input: unknown): Promise<{ error?: string }> {
    const parsed = recoveryResetSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    return completeAccountRecovery(parsed.data.ticket, parsed.data.newPassword);
}
