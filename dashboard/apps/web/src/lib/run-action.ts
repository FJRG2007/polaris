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

/** What the caller sees instead of a crash. Next hides the server's real message in
 *  production, so there is nothing specific to say - and the one cause a reader can
 *  act on, an update that landed under this tab, is not told to them here. Being
 *  asked to reload on the off chance is not guidance; the check below finds out,
 *  and the banner that follows says so and offers the button. */
const FAILED = "The request could not be completed. Try again.";

/**
 * Await a server action, returning null when it rejects and reporting why through
 * `onFailure`. The real error is logged, since the message that reaches the
 * browser is deliberately generic.
 */
export async function runAction<T>(call: () => Promise<T>, onFailure: (message: string) => void): Promise<T | null> {
    try {
        return await call();
    } catch (caught) {
        console.error(caught);
        // The likeliest reason a call is refused with nothing to show for it is that
        // this tab is holding action ids from a build that has been replaced. Asked
        // rather than assumed, and not awaited: the caller gets its answer now, and
        // if the deployment really has moved on the banner says so a moment later.
        void checkForNewBuild();
        onFailure(FAILED);
        return null;
    }
}
