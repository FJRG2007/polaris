/**
 * A start opens the app before it asks about updates. Pure, for the tests:
 * `index.ts` hands it the step that opens the first window and the one that
 * starts the release check (`updates.ts`).
 *
 * The check goes to GitHub, and at sign-in the network may not be up yet, so
 * nothing on screen waits for it. An update it finds downloads and installs in
 * the background, and its notice or restart button appears when it answers.
 */

export interface OpenFirstSteps<T> {
    /** Open the first window. */
    readonly open: () => void;
    /** Start the update check; what it returns is the caller's. */
    readonly check: () => T;
}

export function openBeforeChecking<T>(steps: OpenFirstSteps<T>): T {
    steps.open();
    return steps.check();
}
