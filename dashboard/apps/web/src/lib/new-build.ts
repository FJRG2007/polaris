/**
 * Noticing that the deployment has moved on under an open tab.
 *
 * A tab left open across an update holds a build that is gone: its chunk URLs
 * 404 and the server has never heard of its action ids. `stale-build` catches
 * that after the fact, once something has already failed. This is the half that
 * runs before it - the tab asks what build is being served, and when the answer
 * stops matching the one it was given, it says so and offers the reload.
 *
 * Which is the whole point: nobody should learn that Polaris was updated by
 * having a click refused. Reloading is not done for them, because a reload costs
 * whatever is half-typed on the screen; it is offered, and it waits.
 *
 * The stamp is opaque on purpose. The endpoint answers without a session so the
 * poll costs nothing, and a build identifier handed to anyone who asks is a list
 * of the flaws this deployment has not been updated past yet.
 */

/** What the running build was when this document was served. Null on a build that
 *  carries no stamp - a source build, a dev run - and then there is nothing to
 *  compare against and the watcher stays quiet rather than guessing. */
let served: string | null = null;

/** Set once the answer has stopped matching. One-way: a tab that has seen a new
 *  build has a stale bundle whatever any later answer says. */
let moved = false;

const listeners = new Set<() => void>();

/** Told to the store by the shell, from the server that rendered the page. */
export function rememberServedBuild(stamp: string | null): void {
    if (served === null) served = stamp;
}

export function newBuildReady(): boolean {
    return moved;
}

export function subscribeToBuild(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** In flight, so a burst of failures asks once rather than once each. */
let asking: Promise<boolean> | null = null;

/**
 * Ask what is being served now.
 *
 * Every failure path is silent and answers "nothing has changed": this runs on a
 * timer and behind other people's errors, and a check that cannot reach the
 * server must never be the reason a banner appears.
 */
export async function checkForNewBuild(): Promise<boolean> {
    if (moved || served === null) return moved;
    asking ??= (async () => {
        try {
            const response = await fetch("/api/build", { cache: "no-store" });
            if (!response.ok) return false;
            const data = (await response.json()) as { build?: unknown };
            const current = typeof data.build === "string" ? data.build : null;
            if (current === null || current === served) return false;
            moved = true;
            for (const listener of listeners) listener();
            return true;
        } catch {
            return false;
        } finally {
            asking = null;
        }
    })();
    return asking;
}
