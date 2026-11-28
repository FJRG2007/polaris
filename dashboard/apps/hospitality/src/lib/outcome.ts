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
import { cookies } from "next/headers";
import type { Actor } from "./audit";
import { deviceFromToken } from "./devices";
import { DEVICE_COOKIE } from "../model/device-link";
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
    work: (user: Actor) => Promise<T>
): Promise<Outcome<T>> {
    try {
        return { ok: true, ...(await work(await actorFor(permission))) };
    } catch (caught) {
        if (caught instanceof HospitalityRefusal) {
            return { ok: false, error: (await hospitalityT())(caught.key) };
        }
        if (caught instanceof Error && /NEXT_(REDIRECT|NOT_FOUND)/.test(caught.message)) throw caught;
        console.error("polaris: a hospitality action failed:", caught);
        return { ok: false, error: (await hospitalityT())("errors.generic") };
    }
}

/**
 * Who is acting. A linked device (its token in an httpOnly cookie) can take
 * orders and payments for its venue and nothing else: never a manage action,
 * never another app, never the session of whoever linked it.
 */
export async function actorFor(permission: HospitalityPermission): Promise<Actor> {
    if (permission === "hospitality.use") {
        const token = (await cookies()).get(DEVICE_COOKIE)?.value;
        const device = token ? await deviceFromToken(token) : null;
        if (device) return { id: device.id, name: device.name, device: true, venueId: device.venueId };
    }
    const user = await host.session.requirePermission(permission);
    return { id: user.id, name: user.name ?? "" };
}

export async function invalid(): Promise<{ readonly ok: false; readonly error: string }> {
    return { ok: false, error: (await hospitalityT())("errors.checkInput") };
}
