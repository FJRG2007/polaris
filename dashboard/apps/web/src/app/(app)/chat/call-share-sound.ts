/**
 * Which sound somebody else's screen makes when it goes up or comes down.
 *
 * Everybody in the call hears it, the way every voice client does it: a screen
 * going up is a change in what the call is about, and most of the people in a
 * call are looking at something else - which is the reason they are talking
 * rather than sharing a document. The person sharing hears their own as well;
 * that one is played where they press the button, in `use-sfu-call`.
 *
 * Only the picture counts. A screen's sound is published beside it and taken
 * down with it, so counting both would chime twice for one share.
 *
 * A screen that comes down because its sharer left the call is not announced:
 * the leave sound already says it, and the two back to back are one event heard
 * as two.
 */

/** The source a screen's picture is published under. */
export const SCREEN_SOURCE = "screen_share";

export interface ShareChange {
    /** The publication's source, as the call server carries it. */
    readonly source: string;
    /** Put up rather than taken down. */
    readonly published: boolean;
    /** Whether the sharer is still in the call when it is taken down. */
    readonly stillHere: boolean;
}

export function shareSound(change: ShareChange): "shareOn" | "shareOff" | null {
    if (change.source !== SCREEN_SOURCE) return null;
    if (change.published) return "shareOn";
    return change.stillHere ? "shareOff" : null;
}
