/**
 * Trying a write at once, for the kinds that are only kept on the device when
 * Polaris does not answer (`app-writes`): a task made, a note moved.
 */

import { runAction } from "@/lib/run-action";
import { isNetworkFailure, noteRequestFailure } from "@/lib/reachability";

/** The write never got an answer: the caller keeps it for later. */
export const UNANSWERED = Symbol("unanswered");

/**
 * Run `call`. Answers what it answered, `UNANSWERED` when the request found no
 * server, and null when it failed any other way (the server threw, a replaced
 * build) - which `onFailure` was told, as `runAction` always has.
 */
export async function tryNow<T>(
    call: () => Promise<T>,
    onFailure: (message: string) => void
): Promise<T | null | typeof UNANSWERED> {
    let unanswered = false;
    const answer = await runAction(
        () =>
            call().catch((caught: unknown) => {
                if (!isNetworkFailure(caught)) throw caught;
                noteRequestFailure(caught);
                unanswered = true;
                return null;
            }),
        onFailure
    );
    return unanswered ? UNANSWERED : answer;
}
