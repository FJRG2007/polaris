/**
 * Trying a write at once, for the kinds that are only kept on the device when
 * Polaris does not answer (`app-writes`): a task made, a note moved.
 */

import { runAction } from "@/lib/run-action";
import { checkForNewBuild } from "@/lib/new-build";
import { isStaleBuildError } from "@/lib/stale-build";
import { isNetworkFailure, noteRequestFailure } from "@/lib/reachability";
import type { QueueSendResult } from "./outbox";

/** The write never got an answer: the caller keeps it for later. */
export const UNANSWERED = Symbol("unanswered");

/**
 * Whether a write that threw this can be kept on the device and sent later,
 * instead of being reported as failed. Two failures qualify, and both are what
 * an update of Polaris looks like from an open tab:
 *
 * - nothing answered (the dashboard restarting, the edge answering for it);
 * - the server answered from a newer build that has never heard of this tab's
 *   action ids. The server did not run the write, and this tab cannot send it
 *   again, but the next page load can - the entry outlives the reload.
 *
 * Neither is the server saying no, so neither is the reader's problem.
 */
export function canKeepForLater(caught: unknown): boolean {
    return isNetworkFailure(caught) || isStaleBuildError(caught as { name?: string; message?: string } | null);
}

/**
 * Tell the banners about a failure `canKeepForLater` accepted: a probe for an
 * unanswered one, the reload offer for a replaced build.
 */
function noteKept(caught: unknown): void {
    if (isStaleBuildError(caught as { name?: string; message?: string } | null)) {
        void checkForNewBuild({ failed: true });
        return;
    }
    noteRequestFailure(caught);
}

/**
 * What a queued write that threw counts as. A replaced build is `held`: this
 * page can never send it, no attempt is used up, and the page loaded after the
 * reload sends it with the new ids. Anything else is `unreachable`, as before.
 */
export function undelivered(caught: unknown): Extract<QueueSendResult, string> {
    noteKept(caught);
    return isStaleBuildError(caught as { name?: string; message?: string } | null) ? "held" : "unreachable";
}

/**
 * Run `call`. Answers what it answered, `UNANSWERED` when the request found no
 * server or a newer build that cannot run it (`canKeepForLater`), and null when
 * it failed any other way (the server threw) - which `onFailure` was told, as
 * `runAction` always has.
 */
export async function tryNow<T>(
    call: () => Promise<T>,
    onFailure: (message: string) => void
): Promise<T | null | typeof UNANSWERED> {
    let unanswered = false;
    const answer = await runAction(
        () =>
            call().catch((caught: unknown) => {
                if (!canKeepForLater(caught)) throw caught;
                noteKept(caught);
                unanswered = true;
                return null;
            }),
        onFailure
    );
    return unanswered ? UNANSWERED : answer;
}
