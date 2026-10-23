"use server";

/**
 * Submitting a public intake form.
 *
 * Deliberately outside the authenticated app: the whole point of a form is that
 * somebody with no account can send one. That makes it the least trusted surface
 * in the Tasks app, so the token is the only thing that identifies the form, the
 * answers are validated against the form's own questions rather than a shape the
 * client claims, and a submission is rate limited per address.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import * as gate from "@/lib/tasks/form-access";
import { getTranslations } from "@/lib/i18n/request";
import { UNLOCK_TTL_SECONDS } from "@/lib/link-guards";
import { linkDenialMessage } from "@/lib/link-denial";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { publishTaskChange } from "@/lib/tasks/live";
import { submitForm } from "@/lib/tasks/form-service";

/** How many submissions one address may send per hour. High enough that a real
 *  person filing three bug reports is never stopped. */
const SUBMISSIONS_PER_HOUR = 20;

/** Password guesses allowed per form per address per window. */
const UNLOCK_LIMIT = 8;
const UNLOCK_WINDOW_MS = 10 * 60_000;

export async function submitFormAction(
    token: string,
    answers: Record<string, string>
): Promise<{ confirmation?: string; error?: string }> {
    const ip = (await clientIp()) ?? "unknown";
    const allowed = await rateLimit(`tasks-form:${ip}`, SUBMISSIONS_PER_HOUR, 3_600_000);
    if (!allowed.ok) return { error: (await getTranslations("publicPages"))("form.tooMany") };

    // The same gate the page ran, again: the page may have been open since
    // before the link expired, filled up, or was narrowed.
    const opened = await gate.gateTaskForm(token);
    if (!opened.ok) {
        const t = await getTranslations("publicPages");
        return {
            error:
                opened.reason === "not_found" || opened.reason === "password_required"
                    ? t("form.unavailable")
                    : await linkDenialMessage(opened.reason)
        };
    }

    // A signed-in submitter is recorded, so a form used internally still shows
    // who filed what; an anonymous one simply has no author.
    const session = await getSession();
    const submittedById = (session?.user as { id?: string } | undefined)?.id ?? null;

    try {
        const result = await submitForm(token, answers, submittedById);
        if (!result.ok) return { error: result.error };
        // A request filed from outside lands on the team's board while they are
        // looking at it. Nobody here is a reader of that board - an anonymous
        // submitter has no id at all - so this wakes everyone who can see it.
        publishTaskChange({ spaceId: result.spaceId, actorId: submittedById ?? "" });
        return { confirmation: result.confirmation };
    } catch (caught) {
        console.error(caught);
        return { error: (await getTranslations("publicPages"))("form.failed") };
    }
}

/**
 * The password in front of a form. Answers the same way for a token that names
 * nothing and one that no longer opens, so it cannot be used to find out which
 * tokens are real.
 */
export async function unlockFormAction(token: string, password: string): Promise<{ error?: string }> {
    const t = await getTranslations("publicPages");
    const form = await gate.taskFormForUnlock(token);
    if (!form) return { error: t("denied.unavailable") };
    if (!password || password.length > 256) return { error: t("form.typePassword") };

    const limitKey = `form-unlock:${form.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: t("form.tooManyTries") };
    }
    if (!(await gate.taskFormPasswordMatches(form, password))) {
        return { error: t("form.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    (await cookies()).set(gate.formUnlockCookie(form.id), gate.signFormUnlock(form.id, form.passwordHash), {
        httpOnly: true,
        sameSite: "lax",
        secure: loadEnv().POLARIS_SECURE_COOKIES,
        path: "/",
        maxAge: UNLOCK_TTL_SECONDS
    });
    return {};
}
