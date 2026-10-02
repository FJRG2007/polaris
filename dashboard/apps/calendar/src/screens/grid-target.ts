/**
 * What is under a point of the grid: an event, a time slot, or a day.
 *
 * FullCalendar draws a time grid as two tables stacked on each other - the
 * hour rows underneath, the day columns on top - so no single element knows
 * both the day and the time. Every element under the point is asked instead
 * (`document.elementsFromPoint`, or a focused element and its ancestors for the
 * keyboard): the column says the day, the row beneath it says the time.
 *
 * Pure over the elements it is handed, so it can be asserted without a browser.
 */

/** Something drawn on the grid that a menu can be about. */
export type GridTarget =
    | { readonly kind: "item"; readonly id: string }
    | {
          readonly kind: "slot";
          /** `YYYY-MM-DD`. */
          readonly day: string;
          /** `HH:mm` of the slot in the display zone; null for a whole day, or a
           *  day column reached by keyboard, which has no one time. */
          readonly time: string | null;
          /** The day as a whole: a month cell, the all-day row, a list heading. */
          readonly allDay: boolean;
      };

/** The cells the keyboard steps through: month and year days, the all-day row,
 *  the day columns of a time grid. */
export const KEYBOARD_CELLS = ".fc-daygrid-day[data-date], .fc-timegrid-col[data-date]";

/** Cells that stand for a day. */
const DAY_CELL =
    ".fc-daygrid-day[data-date], .fc-timegrid-col[data-date], .fc-list-day[data-date], .fc-col-header-cell[data-date]";
/** Rows of the time grid that stand for a time. */
const TIME_ROW = ".fc-timegrid-slot[data-time]";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The target the topmost of `elements` stands for, or null when none of them
 *  is part of the grid (a scrollbar, the time axis, the header's padding). */
export function targetFromElements(elements: readonly Element[]): GridTarget | null {
    let day: string | null = null;
    let time: string | null = null;
    let timedColumn = false;
    for (const element of elements) {
        const item = element.closest("[data-event-id]");
        // Only the topmost thing counts as an event: one drawn underneath the
        // point is covered by whatever was pressed.
        if (item && day === null && time === null) {
            const id = item.getAttribute("data-event-id");
            if (id) return { kind: "item", id };
        }
        if (day === null) {
            const cell = element.closest(DAY_CELL);
            const date = cell?.getAttribute("data-date") ?? null;
            if (cell && date && DAY.test(date)) {
                day = date;
                timedColumn = cell.matches(".fc-timegrid-col");
            }
        }
        if (time === null) {
            const row = element.closest(TIME_ROW);
            const value = row?.getAttribute("data-time") ?? "";
            if (/^\d{2}:\d{2}/.test(value)) time = value.slice(0, 5);
        }
        if (day !== null && time !== null) break;
    }
    if (day === null) return null;
    if (timedColumn) return { kind: "slot", day, time, allDay: false };
    return { kind: "slot", day, time: null, allDay: true };
}

/** An element and every element it sits in, innermost first - what the
 *  keyboard has instead of a point. */
export function withAncestors(element: Element): Element[] {
    const chain: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) chain.push(node);
    return chain;
}
