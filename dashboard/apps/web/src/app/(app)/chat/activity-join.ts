/**
 * Handing a game to the call it is played in: the card, a notification or an
 * invitation says "play this here", and the call's own activity hook - which is
 * the only thing that can claim a seat in the game - picks it up as soon as it
 * has a seat to claim with. Kept in the tab's session storage so it survives
 * the call being opened by a navigation.
 */

const KEY = "polaris:activity-join";
/** Older than this, a handoff is not acted on: it was for a call long gone. */
const FRESH_MS = 2 * 60 * 1000;

interface Handoff {
    readonly meetingId: string;
    readonly game: string;
    readonly at: number;
}

/** Ask the call `meetingId` to start or join `game` for this reader. */
export function requestActivityJoin(meetingId: string, game: string): void {
    try {
        const handoff: Handoff = { meetingId, game, at: Date.now() };
        window.sessionStorage.setItem(KEY, JSON.stringify(handoff));
    } catch {
        // Storage refused: the event below still reaches a call that is open.
    }
    window.dispatchEvent(new CustomEvent(KEY, { detail: { meetingId, game } }));
}

/** The game asked for in this call, taken so it is acted on once. */
export function takeActivityJoin(meetingId: string): string | null {
    try {
        const raw = window.sessionStorage.getItem(KEY);
        if (!raw) return null;
        const handoff = JSON.parse(raw) as Partial<Handoff>;
        if (handoff.meetingId !== meetingId || typeof handoff.game !== "string") return null;
        window.sessionStorage.removeItem(KEY);
        return Date.now() - (handoff.at ?? 0) <= FRESH_MS ? handoff.game : null;
    } catch {
        return null;
    }
}

/** Called whenever a handoff is asked for while the page is open. */
export function onActivityJoin(listener: () => void): () => void {
    window.addEventListener(KEY, listener);
    return () => window.removeEventListener(KEY, listener);
}
