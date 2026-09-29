"use server";

/**
 * The public side of account recovery. Every action here is reachable without a
 * session - that is the point of the route - so each one re-validates its input
 * and leaves the throttling and the disclosure rules to the service, which is
 * where they are reasoned about in one place.
 */

import { getTranslations } from "@/lib/i18n/request";
import { clientIp, clientUserAgent } from "@/lib/request-context";
import { validationMessage } from "@/components/i18n/validation-message";
import { recoveryLookupSchema, recoveryRequestSchema, recoveryResetSchema, type AccountRecoveryStatus } from "@polaris/core";
import {
    accountRecoveryQuestions,
    accountRecoveryStatus,
    completeAccountRecovery,
    requestAccountRecovery
} from "@/lib/account-recovery-service";

/** A refusal of the form, in the reader's language. */
async function formError(message: string | undefined): Promise<string> {
    if (message === undefined) return (await getTranslations("auth"))("recover.errors.checkForm");
    return validationMessage(await getTranslations("validation"), message);
}

/** The questions the account set, if it set any and if anyone is asking. */
export async function lookupRecoveryAction(input: unknown): Promise<{ questions: string[]; error?: string }> {
    const parsed = recoveryLookupSchema.safeParse(input);
    if (!parsed.success) return { questions: [], error: await formError(parsed.error.issues[0]?.message) };
    const result = await accountRecoveryQuestions(parsed.data.identifier, (await clientIp()) ?? null);
    if (result.retryAfterMs > 0) {
        const t = await getTranslations("auth");
        return { questions: [], error: t("recover.errors.tooMany", { minutes: Math.ceil(result.retryAfterMs / 60000) }) };
    }
    return { questions: result.questions };
}

/** Raise the request and hand back the ticket that redeems it once approved. */
export async function requestRecoveryAction(input: unknown): Promise<{ ticket: string; error?: string }> {
    const parsed = recoveryRequestSchema.safeParse(input);
    if (!parsed.success) return { ticket: "", error: await formError(parsed.error.issues[0]?.message) };
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
    if (!parsed.success) return { error: await formError(parsed.error.issues[0]?.message) };
    return completeAccountRecovery(parsed.data.ticket, parsed.data.newPassword);
}
