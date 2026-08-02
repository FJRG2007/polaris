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

import { getSession } from "@/lib/session";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { submitForm } from "@/lib/tasks/form-service";

/** How many submissions one address may send per hour. High enough that a real
 *  person filing three bug reports is never stopped. */
const SUBMISSIONS_PER_HOUR = 20;

export async function submitFormAction(
    token: string,
    answers: Record<string, string>
): Promise<{ confirmation?: string; error?: string }> {
    const ip = (await clientIp()) ?? "unknown";
    const allowed = await rateLimit(`tasks-form:${ip}`, SUBMISSIONS_PER_HOUR, 3_600_000);
    if (!allowed.ok) return { error: "Too many submissions from here. Try again in a little while." };

    // A signed-in submitter is recorded, so a form used internally still shows
    // who filed what; an anonymous one simply has no author.
    const session = await getSession();
    const submittedById = (session?.user as { id?: string } | undefined)?.id ?? null;

    try {
        const result = await submitForm(token, answers, submittedById);
        return result.ok ? { confirmation: result.confirmation } : { error: result.error };
    } catch (caught) {
        console.error(caught);
        return { error: "The form could not be sent. Try again in a moment." };
    }
}
