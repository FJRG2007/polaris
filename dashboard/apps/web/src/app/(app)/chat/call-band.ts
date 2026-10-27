/**
 * How much of the column a call is allowed to take.
 *
 * Three cases, and what separates them is what is underneath the call rather
 * than anything about the call itself.
 *
 * A voice channel is a room somebody walked into. The room is the point, its
 * record sits down the side instead of under it, and the call fills whatever it
 * is given. A call started inside a conversation is the other way round - the
 * conversation is the point and the call is happening over it - so it is capped
 * and the messages keep the rest.
 *
 * A direct message is capped hardest, because of what one actually looks like:
 * two circles and a row of buttons. At three fifths of the column that is mostly
 * empty panel, and it pushes the conversation the call was started from off the
 * bottom - so the thing being talked about is gone while people talk about it.
 * Every client that has both draws this as a band across the top, and this is
 * that band.
 *
 * Until somebody puts a screen up. A picture worth watching changes what the
 * column is for, so a staged call outranks the band: at the usual height a
 * shared screen got a third of 60% of the column - about a hand's width of
 * somebody's document - and "make it bigger" could not make it bigger, because
 * the room it would take was being held for messages nobody was reading while a
 * screen was up.
 */

/** Where the call is being drawn, which is what decides how much room it gets. */
export type CallPlace =
    /** A voice channel, which somebody is standing in. */
    | "room"
    /** A direct message, whether one-to-one or a group. */
    | "direct"
    /** A call started inside a channel's conversation. */
    | "channel";

/**
 * Whether the people in the call are drawn as faces rather than as tiles.
 *
 * The same question as the height, asked about the people instead of the panel,
 * and answered from the same fact: a room is what the column is for, so the grid
 * of tiles is the room. A call inside a conversation is happening over the top of
 * something somebody was reading, and there a wall of head-sized rectangles is
 * mostly empty panel taking the space the conversation was using - most of a call
 * is spent with the cameras off.
 *
 * Only while there is nothing to look at, which is the half a picture decides. A
 * face is an avatar and no video element, so a room drawn as faces while somebody
 * has a camera on is a call that draws nobody's picture, local or remote, with
 * "Stop video" on the bar under it and nothing on screen saying why. So a live
 * camera counts exactly as a watched screen does: the moment there is a picture
 * worth the room, the room goes back to tiles.
 *
 * @param staged Whether a shared screen - or a face somebody asked to see bigger
 *   - currently has the big place.
 * @param pictures Whether any camera in the call is sending, this browser's own
 *   included.
 */
export function callBareFaces(place: CallPlace, staged: boolean, pictures: boolean): boolean {
    if (place === "room") return false;
    return !staged && !pictures;
}

/**
 * How a direct message's call is laid out around a stream somebody is watching.
 *
 * One model, the one every voice client draws a call of a few people in: a
 * watched stream fills the call and the people are a strip under it, and how
 * much of the column that is is the divider under the call, dragged to taste.
 *
 * - `people`: nothing is being watched, so the call is the people.
 * - `stream-over-people`: the stream fills the call, the people in a row under
 *   it. What watching looks like, from the moment a share starts.
 * - `stream`: a stream somebody asked to see bigger, alone - the strip is the
 *   last room there is to give it. Pressing it again brings the strip back.
 *
 * This used to have a fourth step, the stream drawn the size of a face among the
 * people until somebody asked for more, and which of the three a press led to
 * depended on whether the call had been expanded. It is gone: the height is the
 * divider's, and full screen is the stream's own tile taken to the display.
 */
export type DirectLayout = "people" | "stream" | "stream-over-people";

/**
 * @param watching Whether any stream is being watched here.
 * @param enlarged Whether a stream was asked for by name ("make this bigger").
 */
export function directLayout(watching: boolean, enlarged: boolean): DirectLayout {
    if (!watching) return "people";
    return enlarged ? "stream" : "stream-over-people";
}

/**
 * The height the call is drawn at.
 *
 * `staged` is whether a shared screen - or a face somebody asked to see bigger -
 * currently has the big place in the room. `expanded` is a call over a
 * conversation that somebody asked to take the whole column - the one case a
 * capped call is not capped, with the conversation put away behind it until it is
 * shrunk.
 *
 * Both kinds of band answer to it, a channel as much as a direct message. The cap
 * is what a call is worth before anybody says otherwise; somebody watching a
 * shared screen has said otherwise, and in a channel that request used to have
 * nowhere to go - the picture stopped at the cap and the only thing left was the
 * whole display, with the call, the people in it and the rest of Polaris gone.
 */
export function callBandHeight(place: CallPlace, staged: boolean, expanded = false): string {
    if (expanded && place !== "room") return "flex-1";
    const cap = bandCap(place, staged);
    // A room has nothing above or below it to share the column with, staged or
    // not: the conversation is beside it.
    return cap === null ? "flex-1" : BAND_CLASS[cap];
}

/**
 * The same limit in pixels, for whoever has to work in them.
 *
 * A share is not something a divider can be dragged against. Given a ceiling of
 * its own, a handle knows nothing about the class holding the panel down: past
 * the point where the share has stopped the panel it goes on counting, and every
 * pixel between the two is a drag that moves nothing on the way out and nothing
 * on the way back, with the number read out to a screen reader belonging to a
 * panel that is not this size.
 *
 * `column` is the height the call is being drawn in, measured. Nothing to measure
 * yet - and a room, which has no share to speak of - leaves the blunt limit, which
 * is all there is to hold a drag to until the column is known.
 */
export function callBandLimit(
    place: CallPlace,
    staged: boolean,
    column: number,
    bounds: { readonly min: number; readonly max: number }
): number {
    const share = callBandShare(place, staged);
    if (share === null || !Number.isFinite(column) || column <= 0) return bounds.max;
    // Never under the floor: a column too short for the smallest usable call is a
    // reason to stop the drag, not to hand back a limit below the one it starts at.
    return Math.max(bounds.min, Math.min(bounds.max, Math.round(column * share)));
}

/** The cap as the share of the column it is. */
function callBandShare(place: CallPlace, staged: boolean): number | null {
    const cap = bandCap(place, staged);
    return cap === null ? null : BAND_SHARE[cap];
}

/** Which of the three caps applies, asked once so that the class and the number
 *  below it cannot be answering different questions. */
function bandCap(place: CallPlace, staged: boolean): keyof typeof BAND_SHARE | null {
    if (place === "room") return null;
    if (staged) return "staged";
    return place === "direct" ? "direct" : "channel";
}

/** The caps, as the share of the column each one is. */
const BAND_SHARE = { direct: 0.4, channel: 0.6, staged: 0.78 } as const;

/** And as the classes that carry them. Written out rather than built from the
 *  numbers above, because these are the strings the stylesheet is generated
 *  from - a class assembled at runtime is one nobody wrote any CSS for. */
const BAND_CLASS = {
    direct: "max-h-[40%]",
    channel: "max-h-[60%]",
    staged: "max-h-[78%]"
} as const;

/**
 * The height the divider says the call is at, which has to be the height on
 * screen: what somebody dragged it to, else what it is drawn at, else the
 * fallback - never under the floor, and never past the ceiling, since a height
 * stored from a taller window is not the height this one is showing.
 */
export function callBandSize(
    stored: number | null,
    drawn: number | null,
    limit: number,
    bounds: { readonly min: number; readonly fallback: number }
): number {
    const wanted = stored ?? drawn ?? bounds.fallback;
    const size = Number.isFinite(wanted) ? wanted : bounds.fallback;
    return Math.min(Math.max(size, bounds.min), Math.max(limit, bounds.min));
}
