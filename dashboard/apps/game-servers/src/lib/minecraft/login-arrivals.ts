/**
 * A player let in by Polaris login, said to whatever shows them something.
 *
 * Until they log in, nothing of Polaris's reaches them (`prelogin.ts`). What
 * Polaris writes on a timer - a challenge's bar, its progress - would otherwise
 * only reach them on its next turn, up to twenty seconds later; told here, it
 * looks again as soon as the mod has let them in.
 *
 * The listeners are whatever is loaded in this process: a feature that is not
 * running for any server has nothing to show and never registers.
 */

type Arrival = (installedAppId: string, player: string) => void;

const listeners = new Set<Arrival>();

/** Be told of every player let in, on any server. */
export function onArrival(listener: Arrival): void {
    listeners.add(listener);
}

/** A player has just been let in. A listener that throws never stops the rest,
 *  nor the login that caused it. */
export function arrived(installedAppId: string, player: string): void {
    for (const listener of listeners) {
        try {
            listener(installedAppId, player);
        } catch (error) {
            console.warn("polaris: a login arrival listener failed", installedAppId, String(error));
        }
    }
}
