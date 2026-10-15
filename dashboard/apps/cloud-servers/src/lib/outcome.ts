/**
 * How an action answers: what it made, or one sentence the person can act on.
 * Only a `CloudRefusal` reaches the screen as written; anything else is logged
 * and replaced with a generic sentence, since it may name internals.
 *
 * Server-only.
 */

import { cloudT } from "./i18n";
import { CloudRefusal } from "./service";

export type Outcome<T> =
    | ({ readonly ok: true } & T)
    | { readonly ok: false; readonly error: string };

export async function outcome<T extends object>(work: () => Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: true, ...(await work()) };
    } catch (caught) {
        if (caught instanceof CloudRefusal) return { ok: false, error: caught.message };
        if (caught instanceof Error && /NEXT_(REDIRECT|NOT_FOUND)/.test(caught.message))
            throw caught;
        console.error(
            "polaris: a cloud-servers action failed:",
            caught instanceof Error ? caught.name : "error"
        );
        return { ok: false, error: (await cloudT())("errors.generic") };
    }
}

export async function invalid(): Promise<{ readonly ok: false; readonly error: string }> {
    return { ok: false, error: (await cloudT())("errors.checkInput") };
}
