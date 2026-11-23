/**
 * The account password as a screen sends it (docs/chat-e2ee-phase1.md,
 * "Password flows over OPAQUE"): proven over OPAQUE when the account can, so
 * it never leaves the browser, and sent as typed on every fallback (an account
 * not moved yet, a worker that does not start, a host without the route). The
 * OPAQUE code is loaded only when a password was typed. `onStretching` fires
 * when the key stretching is about to run, for the slow-submit line.
 *
 * The result is single use: one proof for one server action.
 */

import type { OpaqueFinish } from "@/lib/chat/e2ee/schemas";

export type SentPassword = string | OpaqueFinish;

export async function passwordToSend(password: string, onStretching?: () => void): Promise<SentPassword> {
    if (!password) return password;
    return import("@/lib/chat/e2ee/password-flows-client").then(
        (flows) => flows.sentPassword(password, onStretching),
        () => password
    );
}

/** `passwordToSend` for the screens that clear a gate - the idle lock, an owed
 *  second factor or security key - whose session cannot ask for its state. */
export async function gatePasswordToSend(password: string, onStretching?: () => void): Promise<SentPassword> {
    if (!password) return password;
    return import("@/lib/chat/e2ee/password-flows-client").then(
        (flows) => flows.sentGatePassword(password, onStretching),
        () => password
    );
}
