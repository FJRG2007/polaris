/**
 * Hospitality's in-process change bus: a write publishes the venue it touched,
 * and every open screen of that venue is told to read again
 * (`routes/api/hospitality/stream`). The frame carries no data, so it can never
 * show somebody what they may not read.
 *
 * Every writer is this same server, so nothing leaves the machine: tablets and
 * handhelds on the restaurant's own network stay live with no internet at all.
 * The listener set sits on `globalThis` so a module reloaded in development does
 * not strand the open connections on an old set.
 */

export interface HospitalityChange {
    /** The venue, or null for the shared menu (every venue reads it). */
    readonly venueId: string | null;
    readonly actorId: string;
    /** What moved, so a screen may skip a frame it does not draw. */
    readonly topic: "menu" | "floor" | "orders" | "kitchen" | "cash";
}

type Listener = (change: HospitalityChange) => void;

const REGISTRY = Symbol.for("polaris.hospitality.live");

function listeners(): Set<Listener> {
    const holder = globalThis as { [REGISTRY]?: Set<Listener> };
    if (!holder[REGISTRY]) holder[REGISTRY] = new Set();
    return holder[REGISTRY];
}

export function publishHospitalityChange(change: HospitalityChange): void {
    for (const listener of listeners()) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

export function subscribeHospitalityChanges(listener: Listener): () => void {
    listeners().add(listener);
    return () => listeners().delete(listener);
}
