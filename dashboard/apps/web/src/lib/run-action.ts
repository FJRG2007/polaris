/**
 * Calling a server action from a client component. An action that rejects - the
 * server threw, the network dropped, or the tab is running an older build whose
 * action ids the server no longer knows - leaves an unhandled rejection inside
 * the transition, and React escalates that to the nearest error boundary. With a
 * dialog open that means the whole dashboard is replaced by an error page over
 * one refused request, so every call site folds the failure into its own state
 * instead.
 */

/** What the caller sees instead of a crash. Next hides the server's real message
 *  in production, so the copy points at the one cause an operator can act on. */
const FAILED = "The request could not be completed. If Polaris was just updated, reload the page and try again.";

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
        onFailure(FAILED);
        return null;
    }
}
