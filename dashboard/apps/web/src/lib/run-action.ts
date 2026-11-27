/**
 * Calling a server action from a client component. An action that rejects - the
 * server threw, the network dropped, or the tab is running an older build whose
 * action ids the server no longer knows - leaves an unhandled rejection inside
 * the transition, and React escalates that to the nearest error boundary. With a
 * dialog open that means the whole dashboard is replaced by an error page over
 * one refused request, so every call site folds the failure into its own state
 * instead.
 */

import { checkForNewBuild } from "@/lib/new-build";
import { isStaleBuildError } from "@/lib/stale-build";
import { isNetworkFailure, noteRequestFailure, probeNow, reachability, subscribeReachability } from "@/lib/reachability";
import { noteWriteAccepted, noteWriteRefused } from "@/lib/work-in-progress";

/** What the caller sees instead of a crash. Next hides the server's real message in
 *  production, so there is nothing specific to say - and the one cause a reader can
 *  act on, an update that landed under this tab, is not told to them here. Being
 *  asked to reload on the off chance is not guidance; the check below finds out,
 *  and the banner that follows says so and offers the button. */
let failed = "The request could not be completed. Try again.";

/** What a call is reported with when a newer build answered it: the server never
 *  ran it, and this tab cannot send it again until it has the new build. */
let updated = "Polaris was just updated. Reload the page, then try again.";

/** The sentences above in the reader's language, handed in by the i18n provider
 *  once it knows which - this runs outside any component and cannot ask. */
export function setActionFailureText(text: string, afterUpdate?: string): void {
    failed = text;
    if (afterUpdate) updated = afterUpdate;
}

/** The sentence a failed action is reported with, for a caller that fails the
 *  same way without a rejection of its own to hand `runAction`. */
export function actionFailureText(): string {
    return failed;
}

/** How long a call that found Polaris gone waits for it to come back before it
 *  is reported as failed. Longer than an update takes to roll over. */
export const OUTAGE_WAIT_MS = 10 * 60 * 1000;

/** Calls waiting for Polaris to answer again, so the connection banner can say
 *  they are saved when it is back instead of leaving them silent. */
let waiting = 0;
const waitingListeners = new Set<() => void>();

function setWaiting(next: number): void {
    waiting = next;
    for (const listener of [...waitingListeners]) listener();
}

export function callsWaiting(): number {
    return waiting;
}

/** For `useSyncExternalStore`. */
export function subscribeCallsWaiting(listener: () => void): () => void {
    waitingListeners.add(listener);
    return () => void waitingListeners.delete(listener);
}

/**
 * After a call that got no answer: whether to send it again. Only when Polaris
 * itself is not answering (an update rolling over, a restart) - then the call
 * never reached it, and it is sent again once a probe gets through, the same
 * closure with the same arguments. When Polaris does answer, the failure was
 * this request's own and is reported as before: sending it again blind could
 * repeat something the server did take.
 */
async function waitForPolaris(deadline: number): Promise<boolean> {
    if (await probeNow()) return false;
    setWaiting(waiting + 1);
    try {
        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (answer: boolean): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                unsubscribe();
                resolve(answer);
            };
            const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
            const unsubscribe = subscribeReachability(() => {
                if (reachability().reachable) finish(true);
            });
            // It may have come back between the probe and the subscription.
            if (reachability().reachable) finish(true);
        });
    } finally {
        setWaiting(waiting - 1);
    }
}

/**
 * Await a server action, returning null when it rejects and reporting why through
 * `onFailure`. The real error is logged, since the message that reaches the
 * browser is deliberately generic.
 *
 * A call made while Polaris is not answering at all - the Update button
 * restarting it, a host rebooting - is not reported: it waits, pending, until
 * Polaris answers again and is then sent again (`waitForPolaris`), so a form
 * saved during an update is saved when the update is done. Only a failure once
 * Polaris answers, or an outage longer than `OUTAGE_WAIT_MS`, reaches
 * `onFailure`.
 */
export async function runAction<T>(call: () => Promise<T>, onFailure: (message: string) => void): Promise<T | null> {
    const deadline = Date.now() + OUTAGE_WAIT_MS;
    for (;;) {
        try {
            const answer = await call();
            noteWriteAccepted();
            return answer;
        } catch (caught) {
            console.error(caught);
            const stale = isStaleBuildError(caught as { name?: string; message?: string } | null);
            // The likeliest reason a call is refused with nothing to show for it is that
            // this tab is holding action ids from a build that has been replaced. Asked
            // rather than assumed, and not awaited: the caller gets its answer now, and
            // if the deployment really has moved on the banner says so a moment later.
            void checkForNewBuild({ failed: stale });
            // Or Polaris is not answering at all, which the connection banner says.
            noteRequestFailure(caught);
            if (!stale && isNetworkFailure(caught) && Date.now() < deadline && (await waitForPolaris(deadline))) continue;
            // What the reader sent is not saved: a reload or an update must keep it.
            noteWriteRefused();
            onFailure(stale ? updated : failed);
            return null;
        }
    }
}

/** Back to the first state, for tests. */
export function resetCallsWaiting(): void {
    waiting = 0;
    waitingListeners.clear();
}
