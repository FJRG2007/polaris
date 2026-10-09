/**
 * How an action answers: what it made, or one sentence the person can act on.
 *
 * Only a `CrmRefusal` reaches the screen as it was written. Anything else - a
 * database error, a constraint - is logged here and replaced with a generic
 * sentence, because those name internals nobody asked to publish.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";

export type Outcome<T> =
    | ({ readonly ok: true } & T)
    | { readonly ok: false; readonly error: string };

/** Run an action's work and turn what it throws into an answer. */
export async function outcome<T extends object>(work: () => Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: true, ...(await work()) };
    } catch (caught) {
        if (caught instanceof CrmRefusal) return { ok: false, error: caught.message };
        // A redirect or a not-found from the session is Next's control flow,
        // not a failure: let it through.
        if (caught instanceof Error && /NEXT_(REDIRECT|NOT_FOUND)/.test(caught.message)) {
            throw caught;
        }
        console.error("polaris: a CRM action failed:", caught);
        return { ok: false, error: (await crmT())("errors.generic") };
    }
}

/** What a request that did not pass its schema is answered with. */
export async function invalid(): Promise<{ readonly ok: false; readonly error: string }> {
    return { ok: false, error: (await crmT())("errors.checkInput") };
}
