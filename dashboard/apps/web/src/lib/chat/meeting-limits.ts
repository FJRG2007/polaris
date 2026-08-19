/**
 * The sizes a meeting is bounded by, on both sides of the wire.
 *
 * Their own module, with nothing behind it. The service that enforces them
 * reaches the database on the first line, so a box in a browser that wanted to
 * know how many characters it may accept would have pulled the whole of that in
 * behind the question - which is a bundle nobody asked for and, in a test, a
 * component that will not render without a server around it.
 */

/** How long a meeting's name may be. Long enough for a sentence about what it
 *  is, short enough to sit in a row on a phone. */
export const MAX_MEETING_TITLE = 120;

/** How much one line of a meeting's chat may carry. Long enough for an address
 *  and a sentence about it, which is what this is for. */
export const MAX_MEETING_LINE = 2000;

/**
 * How much of the chat a browser is given.
 *
 * A call is not a conversation with a history to walk back through: this is the
 * last of it and there is no paging. What was said before somebody arrived was
 * not said to them.
 */
export const MEETING_LINES = 200;

/** How far ahead a meeting may be put in the diary. A year is past the point
 *  where anybody is scheduling a call and into the point where somebody has
 *  typed the wrong year. */
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
