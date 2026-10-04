/**
 * Every week of the month grid the same height, the way Google draws it.
 *
 * FullCalendar fills the height it is given, but a table hands the spare room
 * out in proportion to what each row holds, so a busy week came out twice the
 * height of a quiet one. Here the day's events never size the row (they are
 * laid over the cell, as FullCalendar's own "balanced" mode does), and two
 * numbers are read off the drawn grid:
 *
 * - `fit`: how many events one day has room for in an equal share of the
 *   height, with "+N more" under them. The setting's limit is capped by it, so
 *   the weeks fill the view and nothing spills: a limit of 6 on a short window
 *   shows what fits and "+N more", never a week taller than the rest.
 * - `tallest`: the most room any day's events take. With no limit ("All")
 *   every week is at least that high, so the weeks grow to the busiest day
 *   together and the grid scrolls - every event shown, the weeks still equal.
 *   With a limit it is not needed: the limit is capped to what fits.
 */

/** What was read off the grid. */
export interface MonthRoom {
    /** Events one day has room for above "+N more", or null before any event
     *  is drawn. */
    readonly fit: number | null;
    /** Pixels the busiest day's events reach below the top of its cell. */
    readonly tallest: number;
}

/** The `dayMaxEvents` the month grid is given: the setting (0 = all), capped by
 *  what an equal share of the height has room for. Never below one. */
export function monthDayLimit(eventLimit: number, fit: number | null): number | false {
    if (eventLimit === 0) return false;
    return fit === null ? eventLimit : Math.max(1, Math.min(eventLimit, fit));
}

/** Read the month grid under `root`; null when no month grid is drawn there. */
export function measureMonth(root: ParentNode): MonthRoom | null {
    const body = root.querySelector<HTMLElement>(".fc-dayGridMonth-view .fc-daygrid-body");
    const scroller = body?.closest<HTMLElement>(".fc-scroller");
    if (!body || !scroller) return null;
    const weeks = body.querySelectorAll("tbody > tr").length;
    const cells = [...body.querySelectorAll<HTMLElement>("td.fc-daygrid-day")];
    if (weeks === 0 || cells.length === 0) return null;

    let tallest = 0;
    let eventsTop = 0;
    for (const cell of cells) {
        const events = cell.querySelector<HTMLElement>(".fc-daygrid-day-events");
        if (!events) continue;
        const top = cell.getBoundingClientRect().top;
        const box = events.getBoundingClientRect();
        eventsTop = Math.max(eventsTop, box.top - top);
        // A little air under the last one, so it does not sit on the line.
        tallest = Math.max(tallest, Math.ceil(box.bottom - top) + 4);
    }

    // The tallest kind of event drawn (a bar or a dot line), so they all fit.
    let line = 0;
    for (const harness of body.querySelectorAll<HTMLElement>(".fc-daygrid-event-harness"))
        line = Math.max(line, Math.round(harness.getBoundingClientRect().height));
    if (line <= 0) return { fit: null, tallest };
    const share = scroller.clientHeight / weeks;
    // FullCalendar's limit counts events, and draws "+N more" under them: as
    // many events as leave room for that link (as tall as an event until one
    // has been drawn), and a little air.
    let more = 0;
    for (const link of body.querySelectorAll<HTMLElement>(".fc-daygrid-more-link"))
        more = Math.max(more, Math.ceil(link.getBoundingClientRect().height) + 2);
    const events = Math.floor((share - eventsTop - (more || line) - 4) / line);
    return { fit: Math.max(1, events), tallest };
}
