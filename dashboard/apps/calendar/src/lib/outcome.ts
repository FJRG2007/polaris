/**
 * How an action answers: what it made, or one sentence the person can act on.
 *
 * Only a `CalendarRefusal` reaches the screen as it was written. Anything else -
 * a database error, a provider's message - is logged here and replaced with a
 * generic sentence, because those name internals nobody asked to publish.
 *
 * Server-only.
 */

import { CalendarRefusal } from "./errors";
import { host } from "@polaris/app-host";
import { calendarT, ruleTIn } from "./i18n";

export type Outcome<T> =
    | ({ readonly ok: true } & T)
    | { readonly ok: false; readonly error: string };

/** Run an action's work and turn what it throws into an answer. */
export async function outcome<T extends object>(work: () => Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: true, ...(await work()) };
    } catch (caught) {
        if (caught instanceof CalendarRefusal) return { ok: false, error: caught.message };
        // A redirect or a not-found from the session is Next's control flow,
        // not a failure: let it through.
        if (caught instanceof Error && /NEXT_(REDIRECT|NOT_FOUND)/.test(caught.message))
            throw caught;
        console.error("polaris: a calendar action failed:", caught);
        return { ok: false, error: (await calendarT())("errors.generic") };
    }
}

/** The first problem a schema found, as the sentence to show. The engine's
 *  schema messages are keys under `calendarRule.validation`; anything else (a
 *  bare zod type error) reads as "check what you entered". */
export async function invalid(
    issues: readonly { message: string }[]
): Promise<{ ok: false; error: string }> {
    const words = ruleTIn(await host.i18nRequest.getLocale());
    const key = `validation.${issues[0]?.message ?? ""}`;
    if (words.has(key)) return { ok: false, error: words(key) };
    return { ok: false, error: (await calendarT())("errors.checkInput") };
}
