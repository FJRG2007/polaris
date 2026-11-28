/**
 * How an action answers: what it made, or one sentence the person can act on.
 *
 * Only a `HospitalityRefusal` reaches the screen as written. Anything else is
 * logged and replaced with a generic sentence, because those name internals.
 *
 * Server-only.
 */

import { hospitalityT } from "./i18n";
import { host } from "@polaris/app-host";
import type { HospitalityKey } from "../../messages";

export type Outcome<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly error: string };

/** What each kind of work needs. Admin holds all of them. */
export type HospitalityPermission = "hospitality.use" | "hospitality.manage";

export class HospitalityRefusal extends Error {
    constructor(readonly key: HospitalityKey) {
        super(key);
    }
}

export async function outcome<T extends object>(
    permission: HospitalityPermission,
    work: (user: { id: string; name: string }) => Promise<T>
): Promise<Outcome<T>> {
    try {
        const user = await host.session.requirePermission(permission);
        return { ok: true, ...(await work({ id: user.id, name: user.name ?? "" })) };
    } catch (caught) {
        if (caught instanceof HospitalityRefusal) {
            return { ok: false, error: (await hospitalityT())(caught.key) };
        }
        if (caught instanceof Error && /NEXT_(REDIRECT|NOT_FOUND)/.test(caught.message)) throw caught;
        console.error("polaris: a hospitality action failed:", caught);
        return { ok: false, error: (await hospitalityT())("errors.generic") };
    }
}

export async function invalid(): Promise<{ readonly ok: false; readonly error: string }> {
    return { ok: false, error: (await hospitalityT())("errors.checkInput") };
}
