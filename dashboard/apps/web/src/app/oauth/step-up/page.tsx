/**
 * The rest of a sign-in (/oauth/step-up): the factors the account's policy asks
 * for beyond the one already answered, because the sign-in looks unusual or the
 * account always asks for every method.
 *
 * Resolves the session directly rather than through requireUser, which would
 * send a session that still owes factors straight back here.
 */

import { prisma } from "@polaris/db";
import { maskPhone } from "@polaris/core";
import { redirect } from "next/navigation";
import { StepUpView } from "./step-up-view";
import { resolveSession } from "@/lib/session";
import { getUserPhone, listSecurityQuestions } from "@polaris/auth";
import { codeEmailAddress, describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import { emailHint, parseStepUp, stepUpProgress, stepUpRemaining } from "@/lib/two-factor-policy";

export const dynamic = "force-dynamic";

export default async function StepUpPage() {
    const session = await resolveSession();
    if (!session) redirect("/oauth/login");

    const row = await prisma.sessionState.findUnique({
        where: { sessionId: session.sessionId },
        select: { stepUp: true }
    });
    const state = parseStepUp(row?.stepUp);
    if (!row?.stepUp || !state) redirect("/");

    const left = stepUpRemaining(state);
    const [statuses, questions, phone, email] = await Promise.all([
        left.methods.length > 0 ? describeTwoFactorMethods(session.id) : Promise.resolve([]),
        // The questions are the account's own words, and nobody gets to read them
        // - or try answers against them - on a password alone: only once every
        // code this sign-in owes has been entered.
        left.questionLeft && left.factorsLeft === 0 ? listSecurityQuestions(session.id) : Promise.resolve([]),
        (left.methods.includes("whatsapp") || left.methods.includes("sms")) && !state.phoneConfirmed ? getUserPhone(session.id) : Promise.resolve(null),
        left.methods.includes("email") && !state.emailConfirmed ? codeEmailAddress(session.id) : Promise.resolve(null)
    ]);
    // Only what can actually be answered right now: a state read back from a
    // damaged row lists every method, and a channel can go down after sign-in.
    // Reachable is enough - the stored state already holds only the methods
    // this sign-in may use, and a risk check on an account with no second
    // factor offers every way it can receive a code, none of them switched on.
    const methods = left.methods.flatMap((method) => {
        const status = statuses.find((entry) => entry.method === method && entry.available);
        return status ? [{ method, target: status.target ?? null }] : [];
    });

    return (
        <StepUpView
            reason={state.reason}
            progress={stepUpProgress(state)}
            methods={methods}
            questions={questions.map((entry) => entry.question)}
            phoneHint={phone?.verified ? maskPhone(phone.phone) : null}
            phoneConfirmed={state.phoneConfirmed}
            emailHint={email ? emailHint(email) : null}
            emailConfirmed={state.emailConfirmed}
        />
    );
}
