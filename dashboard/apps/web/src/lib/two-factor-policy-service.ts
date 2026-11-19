/**
 * The server half of the second-factor policy: deciding, when a session is first
 * seen, whether the sign-in that opened it owes more factors, and holding the
 * session until it has paid them.
 *
 * better-auth finishes a sign-in after one factor - its verify endpoint creates
 * the session there and then. So the extra factors cannot be part of its
 * challenge; they are owed by the session instead, recorded on its SessionState
 * row the moment guardSession first sees it, and guardSession refuses every
 * request from that session (pages, actions, API routes, the edge) until the row
 * says nothing is owed. It is the same hold a sign-in waiting for approval gets.
 */

import { prisma } from "@polaris/db";
import { resolveGeo } from "@/lib/geo-service";
import type { SecondFactor, TwoFactorMethod } from "@polaris/core";
import { describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import { loadTwoFactorPolicy, rememberSignInCountry, usualSignInCountries } from "@/lib/two-factor-policy-store";
import {
    acceptedMethods,
    isUnusualCountry,
    planStepUp,
    requiredFactors,
    serializeStepUp,
    type StepUpState
} from "@/lib/two-factor-policy";

/** Where a session that owes more factors is sent. */
export const STEP_UP_PATH = "/oauth/step-up";

/** The methods set up on the account that could deliver right now. */
export async function setUpMethods(userId: string): Promise<TwoFactorMethod[]> {
    const statuses = await describeTwoFactorMethods(userId);
    return statuses.filter((status) => status.enabled && status.available).map((status) => status.method);
}

/** The methods a sign-in may use right now, refusals applied. */
export async function acceptedForSignIn(userId: string): Promise<TwoFactorMethod[]> {
    const [setUp, policy] = await Promise.all([setUpMethods(userId), loadTwoFactorPolicy(userId)]);
    return acceptedMethods(setUp, policy.refused);
}

/** The country of an address, or null when it cannot be told. A failed lookup
 *  is an unknown country, never a refused sign-in. */
async function countryOf(ip: string | undefined, known: string | null): Promise<string | null> {
    if (known) return known;
    if (!ip) return null;
    try {
        return (await resolveGeo(ip)).countryCode ?? null;
    } catch {
        return null;
    }
}

/**
 * Decide what the sign-in that opened this session still owes.
 *
 * Cheap for the common case: a sign-in that answered no challenge, or answered
 * it with a backup code, returns before any lookup, and the country is only
 * resolved when the policy would act on it.
 */
export async function beginSignInStepUp(input: {
    userId: string;
    sessionId: string;
    ip: string | undefined;
    country: string | null;
    factor: SecondFactor | null;
}): Promise<{ stepUp: string | null; country: string | null }> {
    const { userId, sessionId, factor } = input;
    if (!factor || factor === "backup-code") {
        await rememberSignInCountry(userId, input.country);
        return { stepUp: null, country: input.country };
    }
    try {
        const [policy, setUp] = await Promise.all([loadTwoFactorPolicy(userId), setUpMethods(userId)]);
        const accepted = acceptedMethods(setUp, policy.refused);
        const country = policy.strictness === "standard" ? input.country : await countryOf(input.ip, input.country);
        const unusual =
            policy.strictness !== "standard" &&
            isUnusualCountry(country, await usualSignInCountries(userId, sessionId));
        const hasQuestions = unusual && (await prisma.securityQuestion.count({ where: { userId } })) > 0;
        const plan: StepUpState | null = planStepUp({
            factor,
            accepted,
            requirement: requiredFactors({
                strictness: policy.strictness,
                unusual,
                accepted: accepted.length,
                hasQuestions
            }),
            reasonHint: unusual ? "unusual-country" : null
        });
        if (!plan) await rememberSignInCountry(userId, country);
        return { stepUp: plan ? serializeStepUp(plan) : null, country };
    } catch (error) {
        // A policy that cannot be read is the default one; the sign-in already
        // answered the challenge it always had to.
        console.error("two-factor policy not applied:", error);
        return { stepUp: null, country: input.country };
    }
}

/**
 * How many steps the challenge screen should say this sign-in will take, before
 * the first one is answered. Only a preview - the session decides for real once
 * it exists - so it assumes the first factor is an accepted method.
 */
export async function previewSignInSteps(userId: string, ip: string | undefined): Promise<number> {
    try {
        const [policy, setUp] = await Promise.all([loadTwoFactorPolicy(userId), setUpMethods(userId)]);
        const accepted = acceptedMethods(setUp, policy.refused);
        const first = accepted[0];
        if (!first) return 1;
        const country = policy.strictness === "standard" ? null : await countryOf(ip, null);
        const unusual = policy.strictness !== "standard" && isUnusualCountry(country, await usualSignInCountries(userId, ""));
        const hasQuestions = unusual && (await prisma.securityQuestion.count({ where: { userId } })) > 0;
        const factor: SecondFactor =
            first === "totp" ? "totp" : first === "email" ? "email-code" : first === "whatsapp" ? "whatsapp-code" : "telegram-code";
        const plan = planStepUp({
            factor,
            accepted,
            requirement: requiredFactors({ strictness: policy.strictness, unusual, accepted: accepted.length, hasQuestions }),
            reasonHint: null
        });
        return plan ? plan.need + (plan.question ? 1 : 0) : 1;
    } catch {
        return 1;
    }
}

/**
 * Write a session's new state, only if nobody else changed it in the meantime -
 * two answers racing must not let either one's progress overwrite the other's
 * into a state that owes less than it should.
 */
export async function advanceStepUp(sessionId: string, previous: string, next: StepUpState | null): Promise<boolean> {
    const { count } = await prisma.sessionState.updateMany({
        where: { sessionId, stepUp: previous },
        data: { stepUp: next ? serializeStepUp(next) : null }
    });
    return count > 0;
}
