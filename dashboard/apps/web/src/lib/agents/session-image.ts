/**
 * Keeping the session image current.
 *
 * `SESSION_IMAGE` is a floating tag (`node:24`), and compose's default pull
 * policy only fetches an image that is missing - so a machine that pulled it once
 * kept that Node for good, CVEs included (one box was found running a copy seven
 * weeks old). The registry is now asked again once a day, in the background of
 * a session start (see `upWithFreshImage`); the start itself always uses the
 * copy on the machine. A pull that fails (the registry is down, the machine is
 * offline) never stops a session, and the next start tries the pull again.
 *
 * Server-only. The day is kept per process, which is enough: a restart costs one
 * extra pull at most.
 */

import type { ComposePullPolicy } from "@polaris/deploy";

export const SESSION_IMAGE_REFRESH_MS = 24 * 60 * 60_000;

/** "always" when the image was not refreshed within the window, else "missing". */
export function sessionPullPolicy(lastPulledAt: number | null, now: number): ComposePullPolicy {
    return lastPulledAt !== null && now - lastPulledAt < SESSION_IMAGE_REFRESH_MS
        ? "missing"
        : "always";
}

/** Per server: each one keeps its own copy of the image, so each one is
 *  refreshed on its own day. `BOX` is this machine. */
const BOX = "box";
const pulls = new Map<string, { lastPulledAt: number | null; refreshing: Promise<void> | null }>();

function stateFor(server: string) {
    let state = pulls.get(server);
    if (!state) {
        state = { lastPulledAt: null, refreshing: null };
        pulls.set(server, state);
    }
    return state;
}

/**
 * Bring a session container up with `up`, and keep the image fresh with
 * `refresh` (a plain pull of it) behind the session rather than in front of it.
 *
 * The pull used to be the start itself (`up("always")`), so the first session of
 * each day - and the first after every restart of the dashboard - waited for a
 * whole Node image to download before anything happened: about a minute in which
 * the person who pressed send saw nothing at all. Now every start uses the image
 * already on the machine (`missing` still pulls one that is not there), and a
 * refresh that is due runs alongside it for the next session. A pull that fails
 * is tried again on the next start.
 */
export async function upWithFreshImage(
    up: (pullPolicy: ComposePullPolicy) => Promise<void>,
    refresh: () => Promise<void>,
    now: () => number = Date.now,
    server: string = BOX
): Promise<void> {
    const state = stateFor(server);
    // On backup access the data saver keeps the cached image: a refresh is a pull
    // of the whole image over the backup line. One that is missing still pulls.
    const saver = await import("@/lib/backup-access")
        .then((m) => m.dataSaverActive())
        .catch(() => false);
    await up("missing");
    if (saver || state.refreshing || sessionPullPolicy(state.lastPulledAt, now()) === "missing")
        return;
    state.refreshing = refresh()
        .then(() => {
            state.lastPulledAt = now();
        })
        .catch((caught: unknown) => {
            console.warn("polaris: the session image could not be refreshed, using the cached one:", caught);
        })
        .finally(() => {
            state.refreshing = null;
        });
}

/**
 * Bring a session up on the session machine image when the box has it, and on
 * the stock image when it does not.
 *
 * `up(image, pullPolicy)` brings the container up on `image`. The machine image
 * is tried with "never", so a box that has not pulled it yet fails at once
 * rather than downloading a browser in front of the person who pressed send;
 * that session starts on `fallback` exactly as every session did before, and
 * the daily refresh - which now fetches the machine image - pulls it behind
 * the session, so the next one is on it. A registry that does not have it yet
 * (an install that updated before CI published it) is the same case: warned,
 * and tried again on the next start.
 *
 * The work survives the switch: the home and the checkout are on the box (see
 * `AGENT_HOME`, `SESSION_ROOT`), so a container recreated on the other image
 * reopens on the same files.
 */
export async function upWithSessionImage(
    up: (image: string, pullPolicy: ComposePullPolicy) => Promise<void>,
    pull: (image: string) => Promise<void>,
    images: { machine: string; fallback: string },
    now: () => number = Date.now,
    server: string = BOX
): Promise<void> {
    await upWithFreshImage(
        async (pullPolicy) => {
            try {
                await up(images.machine, "never");
            } catch (caught) {
                console.warn("polaris: starting this session on the stock image, the session machine is not here yet:", caught);
                await up(images.fallback, pullPolicy);
            }
        },
        // While the machine image cannot be had, the stock image is the one in
        // use, so it is the one kept fresh; the failure is passed on so the
        // machine image is tried again on the next start.
        async () => {
            try {
                await pull(images.machine);
            } catch (caught) {
                await pull(images.fallback).catch(() => undefined);
                throw caught;
            }
        },
        now,
        server
    );
}

/** For tests: the refresh running now, if any. */
export function sessionImageRefreshing(server: string = BOX): Promise<void> | null {
    return pulls.get(server)?.refreshing ?? null;
}

/** For tests: forget when the image was last refreshed. */
export function resetSessionImageRefresh(): void {
    pulls.clear();
}
