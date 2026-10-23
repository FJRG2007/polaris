/**
 * How an action answers: what it made, or one sentence the person can act on.
 *
 * Only a `StatusRefusal` reaches the screen as written. Anything else is logged
 * and replaced with a generic sentence, because those name internals.
 *
 * Server-only.
 */

import { statusT } from "./i18n";
import { host } from "@polaris/app-host";
import type { StatusKey } from "../../messages";

export type Outcome<T> =
    ({ readonly ok: true } & T) | { readonly ok: false; readonly error: string };

/** A refusal the reader can act on, named by its message key. */
export class StatusRefusal extends Error {
    constructor(readonly key: StatusKey) {
        super(key);
    }
}

/** The signed-in person, refusing anybody who may not manage status pages. */
export async function requireStatusManager() {
    return host.session.requirePermission("status.manage");
}

/** Runs an action's work as a status manager and turns what it throws into an answer. */
export async function outcome<T extends object>(
    work: (userId: string) => Promise<T>
): Promise<Outcome<T>> {
    return settle(requireStatusManager, work);
}

/** Runs an action's work as whoever `gate` lets through, and turns what either
 *  throws into an answer. */
export async function settle<T extends object>(
    gate: () => Promise<{ id: string }>,
    work: (userId: string) => Promise<T>
): Promise<Outcome<T>> {
    try {
        const user = await gate();
        return { ok: true, ...(await work(user.id)) };
    } catch (caught) {
        if (caught instanceof StatusRefusal) {
            return { ok: false, error: (await statusT())(caught.key) };
        }
        if (caught instanceof Error && /NEXT_(REDIRECT|NOT_FOUND)/.test(caught.message)) {
            throw caught;
        }
        console.error("polaris: a status pages action failed:", caught);
        return { ok: false, error: (await statusT())("errors.generic") };
    }
}

/** What a request that did not pass its schema is answered with. */
export async function invalid(): Promise<{ readonly ok: false; readonly error: string }> {
    return { ok: false, error: (await statusT())("errors.checkInput") };
}
