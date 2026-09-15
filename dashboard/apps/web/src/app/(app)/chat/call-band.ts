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
 * The height the call is drawn at.
 *
 * `staged` is whether a shared screen - or a face somebody asked to see bigger -
 * currently has the big place in the room.
 */
export function callBandHeight(place: CallPlace, staged: boolean): string {
    // A room has nothing above or below it to share the column with, staged or
    // not: the conversation is beside it.
    if (place === "room") return "flex-1";
    if (staged) return "max-h-[78%]";
    return place === "direct" ? "max-h-[40%]" : "max-h-[60%]";
}
