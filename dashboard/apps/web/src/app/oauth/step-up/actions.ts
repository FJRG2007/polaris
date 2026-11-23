"use server";

/**
 * Answering the extra factors a sign-in owes under its account's policy.
 *
 * Every action here works on the caller's own session only, read through
 * resolveSession because guardSession is what sent it here and would send it
 * back. Each answer is checked against what the session still owes - a method
 * that is not owed, or already answered, changes nothing - and the codes go
 * through the same rate-limited confirmation as every other step-up in Polaris.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { resolveSession } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { proveStepUp, sendStepUpCode } from "@/lib/step-up";
import { advanceStepUp } from "@/lib/two-factor-policy-service";
import { codeEmailAddress } from "@/lib/two-factor-delivery";
import { getUserPhone, verifySecurityAnswers } from "@polaris/auth";
import { rememberSignInCountry } from "@/lib/two-factor-policy-store";
import { otpCodeField, TWO_FACTOR_DELIVERY_METHODS } from "@polaris/core";
import {
    emailMatches,
    parseStepUp,
    phoneMatches,
    recordFactor,
    stepUpComplete,
    stepUpRemaining,
    type StepUpState
} from "@/lib/two-factor-policy";

export type StepUpResult = { error?: string; complete?: boolean };

/** What sign-in codes are minted against, apart from any other confirmation. */
const PURPOSE = "sign-in-step-up";

/** One purpose per channel, so a code sent by email can never be counted as the
 *  WhatsApp factor, or the other way round. */
function purposeFor(method: string): string {
    return `${PURPOSE}:${method}`;
}

const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const sendSchema = z.object({
    method: z.enum(TWO_FACTOR_DELIVERY_METHODS),
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().toLowerCase().max(320).optional()
});

const proveSchema = z.object({
    method: z.enum(["totp", ...TWO_FACTOR_DELIVERY_METHODS]),
    code: otpCodeField
});

const answersSchema = z.object({
    answers: z.array(z.string().trim().min(1).max(200)).min(1).max(10)
});

/** The caller's session and what it still owes, or null when it owes nothing. */
async function owed(): Promise<{ userId: string; sessionId: string; raw: string; state: StepUpState; country: string | null } | null> {
    const session = await resolveSession();
    if (!session) return null;
    const row = await prisma.sessionState.findUnique({
        where: { sessionId: session.sessionId },
        select: { stepUp: true, country: true }
    });
    const state = parseStepUp(row?.stepUp);
    if (!row?.stepUp || !state) return null;
    return { userId: session.id, sessionId: session.sessionId, raw: row.stepUp, state, country: row.country };
}

async function words() {
    return readerWords("auth");
}

/** Save the new state, and open the session when nothing is owed any more. */
async function settle(current: NonNullable<Awaited<ReturnType<typeof owed>>>, next: StepUpState): Promise<StepUpResult> {
    const complete = stepUpComplete(next);
    if (!(await advanceStepUp(current.sessionId, current.raw, complete ? null : next))) {
        return { error: (await words())("stepUp.changed") };
    }
    if (complete) {
        await rememberSignInCountry(current.userId, current.country);
        await recordAudit({
            actorId: current.userId,
            action: "account.signin.step-up-passed",
            targetType: "session",
            targetId: current.sessionId,
            metadata: { reason: next.reason, factors: next.done, question: next.question }
        });
    }
    return { complete };
}

export async function sendStepUpFactorCodeAction(input: unknown): Promise<StepUpResult> {
    const t = await words();
    const current = await owed();
    if (!current) return { complete: true };
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success) return { error: t("stepUp.notOwed") };
    const { method, phone, email } = parsed.data;
    if (!stepUpRemaining(current.state).methods.includes(method)) return { error: t("stepUp.notOwed") };

    // Like Google asks before texting a code: the number has to be typed back
    // before a code is sent to it, so somebody holding only the password cannot
    // learn which number the account uses or make it ring.
    if (method === "whatsapp" && !current.state.phoneConfirmed) {
        const throttle = await rateLimit(`step-up-phone:${current.userId}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS);
        if (!throttle.ok) return { error: t("stepUp.tooMany") };
        const known = await getUserPhone(current.userId);
        if (!phone || !known?.verified || !phoneMatches(phone, known.phone)) {
            await recordAudit({
                actorId: current.userId,
                action: "account.signin.step-up-phone-failed",
                targetType: "session",
                targetId: current.sessionId
            });
            return { error: t("stepUp.wrongPhone") };
        }
        const next = { ...current.state, phoneConfirmed: true };
        if (!(await advanceStepUp(current.sessionId, current.raw, next))) return { error: t("stepUp.changed") };
    }

    // The same for an email code: the whole address, shown only as f***@g***.com.
    if (method === "email" && !current.state.emailConfirmed) {
        const throttle = await rateLimit(`step-up-email:${current.userId}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS);
        if (!throttle.ok) return { error: t("stepUp.tooMany") };
        const known = await codeEmailAddress(current.userId);
        if (!email || !known || !emailMatches(email, known)) {
            await recordAudit({
                actorId: current.userId,
                action: "account.signin.step-up-email-failed",
                targetType: "session",
                targetId: current.sessionId
            });
            return { error: t("stepUp.wrongEmail") };
        }
        const next = { ...current.state, emailConfirmed: true };
        if (!(await advanceStepUp(current.sessionId, current.raw, next))) return { error: t("stepUp.changed") };
    }

    // The method was checked against this session's own stored step-up above,
    // which for a risk check lists every way the account can receive a code.
    const sent = await sendStepUpCode(current.userId, purposeFor(method), method, { anyReachable: true });
    return sent.error ? { error: sent.error } : {};
}

export async function proveStepUpFactorAction(input: unknown): Promise<StepUpResult> {
    const t = await words();
    const current = await owed();
    if (!current) return { complete: true };
    const parsed = proveSchema.safeParse(input);
    if (!parsed.success) return { error: t("twoFactor.codeInvalid") };
    const { method, code } = parsed.data;
    if (!stepUpRemaining(current.state).methods.includes(method)) return { error: t("stepUp.notOwed") };
    // A WhatsApp code can only have been sent after the number was confirmed.
    if (method === "whatsapp" && !current.state.phoneConfirmed) return { error: t("stepUp.notOwed") };
    if (method === "email" && !current.state.emailConfirmed) return { error: t("stepUp.notOwed") };

    const proven = await proveStepUp(current.userId, purposeFor(method), { proof: method, code }, { anyReachable: true });
    if (proven.error) return { error: proven.error };
    return settle(current, recordFactor(current.state, method));
}

export async function answerStepUpQuestionsAction(input: unknown): Promise<StepUpResult> {
    const t = await words();
    const current = await owed();
    if (!current) return { complete: true };
    if (!stepUpRemaining(current.state).questionLeft) return { error: t("stepUp.notOwed") };
    const parsed = answersSchema.safeParse(input);
    if (!parsed.success) return { error: t("stepUp.wrongAnswers") };

    const throttle = await rateLimit(`step-up-question:${current.userId}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS);
    if (!throttle.ok) return { error: t("stepUp.tooMany") };
    if (!(await verifySecurityAnswers(auth, current.userId, parsed.data.answers))) {
        await recordAudit({
            actorId: current.userId,
            action: "account.signin.step-up-question-failed",
            targetType: "session",
            targetId: current.sessionId
        });
        return { error: t("stepUp.wrongAnswers") };
    }
    return settle(current, { ...current.state, questionDone: true });
}
