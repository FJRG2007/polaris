// @vitest-environment jsdom

/**
 * Every week of the month grid the same height: the setting's limit capped by
 * what an equal share of the height holds, "All" growing every week to the
 * busiest day together, and the grid drawing only the month's own weeks.
 */

import "@/components/app-host/client";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import GridView, { type GridViewProps } from "@polaris-app/calendar/src/screens/grid-view";
import { GRID_CSS } from "@polaris-app/calendar/src/screens/grid-css";
import {
    measureMonth,
    monthDayLimit,
    monthLimits
} from "@polaris-app/calendar/src/screens/month-rows";
import { readPreferences } from "@polaris-app/calendar/src/lib/preferences";

afterEach(cleanup);

describe("monthDayLimit", () => {
    it("keeps the setting while nothing has been measured", () => {
        expect(monthDayLimit(4, null)).toBe(4);
    });

    it("caps the setting at what a week's share of the height holds", () => {
        expect(monthDayLimit(6, 3)).toBe(3);
        expect(monthDayLimit(2, 5)).toBe(2);
        expect(monthDayLimit(4, 0)).toBe(1);
    });

    it("shows every event when the setting is All", () => {
        expect(monthDayLimit(0, 3)).toBe(false);
    });
});

describe("monthLimits", () => {
    const room = { fit: 3, rows: 4, tallest: 200 };

    it("fills a day by default, the link taking only the last line", () => {
        // Four lines: four events show all four, a fifth makes it 3 + "+2 more".
        expect(monthLimits("fit", room)).toEqual({ dayMaxEvents: false, dayMaxEventRows: 4 });
    });

    it("lets FullCalendar read the cell before anything is measured", () => {
        expect(monthLimits("fit", null)).toEqual({ dayMaxEvents: false, dayMaxEventRows: true });
    });

    it("keeps a number chosen in settings, capped by what fits", () => {
        expect(monthLimits(6, room)).toEqual({ dayMaxEvents: 3, dayMaxEventRows: false });
        expect(monthLimits(0, room)).toEqual({ dayMaxEvents: false, dayMaxEventRows: false });
    });
});

describe("the month's setting, as stored before it could fit", () => {
    it("reads the old default of 4 as filling the day", () => {
        expect(readPreferences(JSON.stringify({ eventLimit: 4 })).monthEvents).toBe("fit");
        expect(readPreferences(null).monthEvents).toBe("fit");
    });

    it("keeps another number somebody chose, and All", () => {
        expect(readPreferences(JSON.stringify({ eventLimit: 6 })).monthEvents).toBe(6);
        expect(readPreferences(JSON.stringify({ eventLimit: 0 })).monthEvents).toBe(0);
    });

    it("prefers the new setting once there is one", () => {
        expect(
            readPreferences(JSON.stringify({ eventLimit: 6, monthEvents: "fit" })).monthEvents
        ).toBe("fit");
    });
});

/** A rectangle at `top`, `height` high. */
function box(top: number, height: number): DOMRect {
    return new DOMRect(0, top, 100, height);
}

/** A month grid of `weeks` rows in a scroller `height` high: each day's events
 *  start 30px into the cell; the first day holds `busy` events 24px high and a
 *  "+N more" link 15px high. */
function monthGrid(weeks: number, height: number, busy: number): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = `
        <div class="fc-dayGridMonth-view">
            <div class="fc-scroller">
                <div class="fc-daygrid-body"><table><tbody>
                    ${Array.from({ length: weeks }, () => `<tr><td class="fc-daygrid-day"><div class="fc-daygrid-day-events"></div></td></tr>`).join("")}
                </tbody></table></div>
            </div>
        </div>`;
    const scroller = root.querySelector<HTMLElement>(".fc-scroller")!;
    Object.defineProperty(scroller, "clientHeight", { value: height });
    const share = height / weeks;
    root.querySelectorAll<HTMLElement>("td.fc-daygrid-day").forEach((cell, index) => {
        const top = index * share;
        cell.getBoundingClientRect = () => box(top, share);
        const events = cell.querySelector<HTMLElement>(".fc-daygrid-day-events")!;
        const reach = index === 0 ? busy * 24 + 15 : 0;
        events.getBoundingClientRect = () => box(top + 30, reach);
        if (index !== 0) return;
        for (let at = 0; at < busy; at += 1) {
            const harness = document.createElement("div");
            harness.className = "fc-daygrid-event-harness";
            harness.getBoundingClientRect = () => box(top + 30 + at * 24, 24);
            events.appendChild(harness);
        }
        const more = document.createElement("a");
        more.className = "fc-daygrid-more-link";
        more.getBoundingClientRect = () => box(top + 30 + busy * 24, 15);
        events.appendChild(more);
    });
    return root;
}

describe("measureMonth", () => {
    it("counts the events a week's equal share holds above the more link", () => {
        // 750 / 5 = 150 a week: the link (17) is below an event's height (24), so
        // it is given that instead: 150 - 30 - 24 - 4 = 92, three events of 24.
        expect(measureMonth(monthGrid(5, 750, 9))?.fit).toBe(3);
        // A shorter window holds fewer: 90 - 30 - 24 - 4 = 32, one event.
        expect(measureMonth(monthGrid(5, 450, 9))?.fit).toBe(1);
    });

    it("counts the lines a day holds, the link's included", () => {
        // (150 - 30 - 4) / 24 = 4.8: four lines.
        expect(measureMonth(monthGrid(5, 750, 9))?.rows).toBe(4);
    });

    it("reports how far the busiest day's events reach, for All", () => {
        // 30 down, nine events and the link (231), and 4 of air.
        expect(measureMonth(monthGrid(5, 750, 9))?.tallest).toBe(30 + 9 * 24 + 15 + 4);
    });

    it("cannot say what fits before an event is drawn", () => {
        expect(measureMonth(monthGrid(5, 750, 0))?.fit).toBeNull();
    });

    it("reads nothing where no month grid is drawn", () => {
        expect(measureMonth(document.createElement("div"))).toBeNull();
    });
});

describe("the month grid's rules", () => {
    it("lays a day's events over its cell, so they never size the week", () => {
        expect(GRID_CSS).toMatch(
            /\.fc-dayGridMonth-view \.fc-daygrid-day-events \{ position: absolute;/
        );
        expect(GRID_CSS).toMatch(
            /\.fc-dayGridMonth-view \.fc-daygrid-body tbody > tr \{ height: var\(--pc-week-min, auto\); \}/
        );
    });
});

function props(patch: Partial<GridViewProps>): GridViewProps {
    return {
        view: "month",
        anchor: "2026-10-07",
        customDays: 4,
        zone: "UTC",
        secondaryZone: null,
        locale: "en-US",
        hour12: false,
        firstDay: 1,
        showWeekends: true,
        showWeekNumbers: false,
        now: new Date("2026-10-07T10:00:00Z"),
        dimPast: false,
        scrollToNowSignal: 0,
        slotMinutes: 30,
        dayStart: "08:00",
        eventLimit: 4,
        businessHours: [],
        events: [],
        selectedId: null,
        selection: null,
        words: {
            allDay: "All day",
            noEvents: "No events",
            week: "W",
            more: (count) => `+${count} more`,
            secondaryZone: "",
            day: (day) => day
        },
        onSelectRange: () => true,
        onItemClick: () => undefined,
        onItemFocus: () => undefined,
        onChange: () => undefined,
        onTaskDrop: () => undefined,
        onTaskToggle: () => undefined,
        onOpenDay: () => undefined,
        ...patch
    };
}

describe("the month grid", () => {
    it("draws only the month's own weeks, as Google does", () => {
        // October 2026 from Monday: 28 Sep to 1 Nov, five weeks.
        const { container } = render(<GridView {...props({})} />);
        expect(container.querySelectorAll(".fc-daygrid-body tbody > tr")).toHaveLength(5);
        // November 2026 needs six: it starts on a Sunday.
        cleanup();
        const next = render(<GridView {...props({ anchor: "2026-11-10" })} />);
        expect(next.container.querySelectorAll(".fc-daygrid-body tbody > tr")).toHaveLength(6);
    });
});
