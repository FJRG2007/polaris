/**
 * An action's `{ ok, error }` answer as a value or a thrown sentence, so a
 * screen can `await` a call and put whatever it threw on screen as it is.
 *
 * A call that never reached the server (a dropped connection, a tab holding a
 * build that has been replaced) is answered with `fallback`, after the host has
 * told the reader what happened in its own banner.
 */

import { hostUi } from "@polaris/app-host/client";

export async function unwrap<T extends { ok: boolean }>(
    call: () => Promise<T>,
    fallback: string
): Promise<Extract<T, { ok: true }>> {
    let failure = fallback;
    const answer = await hostUi.runAction.runAction(call, (message) => {
        failure = message;
    });
    if (!answer) throw new Error(failure);
    if (!answer.ok) throw new Error((answer as unknown as { error: string }).error);
    return answer as Extract<T, { ok: true }>;
}

/** What a thrown value says, for a toast's body. */
export function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}
