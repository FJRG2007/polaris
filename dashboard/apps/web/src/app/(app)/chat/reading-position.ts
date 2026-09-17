/**
 * Keeping a reader on the line they are reading while the list changes above it.
 *
 * The conversation opts out of the browser's own scroll anchoring, because that
 * fights the list following the newest message. For a reader further up, the
 * same job is done here: the first message they can see is remembered with its
 * distance from the top, and after anything above it changes height - a page of
 * older messages, a picture that finished loading, a link card - the list is
 * scrolled by exactly how far that message moved.
 */

/** The line a reader is on: the first message at the top of the list, and how
 *  far below the top edge it sits. */
export interface ReadingPosition {
    readonly id: string;
    readonly offset: number;
}

/** The message rows inside the list, in order. */
function messageRows(scroller: HTMLElement): HTMLElement[] {
    return Array.from(scroller.querySelectorAll<HTMLElement>('[id^="message-"]'));
}

/**
 * The first message the reader can see, and where it sits.
 *
 * A binary search over the rows, because they are in order and a window holds
 * up to two hundred of them: this runs while scrolling.
 */
export function readingPosition(scroller: HTMLElement): ReadingPosition | null {
    const rows = messageRows(scroller);
    if (rows.length === 0) return null;
    const top = scroller.getBoundingClientRect().top;
    let low = 0;
    let high = rows.length - 1;
    while (low < high) {
        const middle = (low + high) >> 1;
        if ((rows[middle] as HTMLElement).getBoundingClientRect().bottom > top) high = middle;
        else low = middle + 1;
    }
    const row = rows[low] as HTMLElement;
    return { id: row.id, offset: row.getBoundingClientRect().top - top };
}

/**
 * Scroll so the remembered message sits where it did, and say where the reader
 * now is.
 *
 * A message that has left the window - trimmed away, or deleted - cannot be
 * held on to, so the position is simply read again.
 */
export function keepReading(
    scroller: HTMLElement,
    was: ReadingPosition | null
): ReadingPosition | null {
    if (!was) return readingPosition(scroller);
    const row = scroller.ownerDocument.getElementById(was.id);
    if (!row || !scroller.contains(row)) return readingPosition(scroller);
    const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const moved = offset - was.offset;
    if (Math.abs(moved) >= 1) scroller.scrollTop += moved;
    return was;
}
