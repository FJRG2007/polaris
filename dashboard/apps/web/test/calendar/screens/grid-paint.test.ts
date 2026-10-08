/**
 * How the grid fills an event: solid in its colour while the reader takes part,
 * outlined over a tint while unanswered or "maybe", outlined over stripes when
 * declined or cancelled, faded once past - and in every one of those, for every
 * colour a calendar can be given and on both themes, text that reads at 4.5:1.
 */

import { describe, expect, it } from "vitest";
import { CALENDAR_COLORS } from "@polaris-app/calendar/src/lib/schemas";
import {
    contrast,
    hexOfHslChannels,
    inkFor,
    mix,
    TEXT_CONTRAST
} from "@polaris-app/calendar/src/screens/ui-color";
import {
    DARK_SURFACE,
    gridEvents,
    paintFor,
    type EventResponse
} from "@polaris-app/calendar/src/screens/grid-events";
import type {
    CalendarSummary,
    OccurrenceView,
    RangeView,
    TaskItemView
} from "@polaris-app/calendar/src/lib/wire";

/** The card of each theme, from the tokens (`packages/ui/src/styles/tokens.css`). */
const SURFACES = {
    dark: hexOfHslChannels("225 11% 9%")!,
    light: hexOfHslChannels("0 0% 100%")!,
    midnight: hexOfHslChannels("225 13% 7%")!,
    graphite: hexOfHslChannels("220 4% 11%")!
};

/** Google's event colours, which a synced event can carry, beside the palette. */
const GOOGLE_COLORS = [
    "#a4bdfc",
    "#7ae7bf",
    "#dbadff",
    "#ff887c",
    "#fbd75b",
    "#ffb878",
    "#46d6db",
    "#e1e1e1",
    "#5484ed",
    "#51b749",
    "#dc2127"
];

const RESPONSES: EventResponse[] = ["accepted", "needs-action", "tentative", "declined"];

describe("the ink on an event", () => {
    it("reads at 4.5:1 on every colour, state and theme", () => {
        const failures: string[] = [];
        for (const color of [...CALENDAR_COLORS, ...GOOGLE_COLORS, "#ffffff", "#000000", "#808080"])
            for (const [theme, surface] of Object.entries(SURFACES))
                for (const response of RESPONSES)
                    for (const past of [false, true])
                        for (const struck of [false, true])
                            for (const busy of [false, true]) {
                                const paint = paintFor(
                                    color,
                                    { response, past, struck, busy },
                                    surface
                                );
                                const fills = paint.stripe
                                    ? [paint.fill, paint.stripe]
                                    : [paint.fill];
                                const worst = Math.min(
                                    ...fills.map((fill) => contrast(paint.ink, fill))
                                );
                                if (worst < TEXT_CONTRAST)
                                    failures.push(
                                        `${color} ${theme} ${response} past=${past} struck=${struck} busy=${busy}: ${worst.toFixed(2)}`
                                    );
                            }
        expect(failures).toEqual([]);
    });

    it("picks the side that reads better rather than a fixed threshold", () => {
        // A mid violet: white is 4.3:1 and the design's near-black 4.4:1, so
        // neither passes and the ink goes to pure black (4.9:1).
        expect(inkFor("#9467bd")).toBe("#000000");
        expect(inkFor("#2563eb")).toBe("#ffffff");
        expect(inkFor("#bcbd22")).toBe("#111318");
    });
});

describe("how an event is filled", () => {
    const blue = "#2563eb";

    it("fills an event the reader takes part in with its own colour", () => {
        const paint = paintFor(blue, { response: "accepted", past: false, struck: false });
        expect(paint).toEqual({ fill: blue, edge: blue, ink: "#ffffff", stripe: null });
    });

    it("outlines an unanswered or tentative event over a tint of its colour", () => {
        for (const response of ["needs-action", "tentative"] as const) {
            const paint = paintFor(blue, { response, past: false, struck: false }, SURFACES.light);
            expect(paint.edge).toBe(blue);
            expect(paint.fill).not.toBe(blue);
            expect(paint.fill).toBe(mix(blue, SURFACES.light, 0.18));
            expect(paint.stripe).toBeNull();
        }
    });

    it("stripes a declined or cancelled event over the page, outlined in its colour", () => {
        const declined = paintFor(blue, { response: "declined", past: false, struck: false });
        const cancelled = paintFor(blue, { response: "accepted", past: false, struck: true });
        for (const paint of [declined, cancelled]) {
            expect(paint.fill).toBe(DARK_SURFACE);
            expect(paint.edge).toBe(blue);
            expect(paint.stripe).not.toBeNull();
        }
    });

    it("fades a past event toward the page, in either theme", () => {
        const dark = paintFor(
            blue,
            { response: "accepted", past: true, struck: false },
            SURFACES.dark
        );
        const light = paintFor(
            blue,
            { response: "accepted", past: true, struck: false },
            SURFACES.light
        );
        expect(dark.fill).toBe(mix(blue, SURFACES.dark, 0.55));
        expect(light.fill).toBe(mix(blue, SURFACES.light, 0.55));
        expect(contrast(dark.fill, SURFACES.dark)).toBeLessThan(contrast(blue, SURFACES.dark));
        expect(contrast(light.fill, SURFACES.light)).toBeLessThan(contrast(blue, SURFACES.light));
    });

    it("falls back to grey for a colour it cannot read", () => {
        expect(
            paintFor("rebeccapurple", { response: "accepted", past: false, struck: false }).fill
        ).toBe("#7f7f7f");
    });
});

describe("the grid's events", () => {
    const calendar = {
        id: "c1",
        name: "Work",
        color: "#d62728",
        hidden: false
    } as unknown as CalendarSummary;
    const occurrence = (patch: Partial<OccurrenceView>): OccurrenceView =>
        ({
            objectId: "o1",
            recurrenceKey: "k1",
            calendarId: "c1",
            summary: "Standup",
            start: "2026-10-05T09:00:00Z",
            end: "2026-10-05T09:30:00Z",
            allDay: false,
            startDate: null,
            endDate: null,
            color: null,
            status: null,
            myPartstat: null,
            busyOnly: false,
            transparent: false,
            recurring: false,
            editable: true,
            location: null,
            conference: null,
            ...patch
        }) as OccurrenceView;
    const draw = (occurrences: OccurrenceView[], now = "2026-10-01T00:00:00Z") =>
        gridEvents({ occurrences, tasks: [] } as unknown as RangeView, {
            zone: "UTC",
            locale: "en-US",
            now: new Date(now),
            showDeclined: true,
            showTasks: true,
            dimPast: true,
            surface: SURFACES.light,
            calendars: new Map([["c1", calendar]]),
            t: ((key: string) => key) as never
        });

    it("hands the grid a filled event, a free one included", () => {
        const [busy, free] = draw([
            occurrence({}),
            occurrence({ objectId: "o2", transparent: true })
        ]);
        for (const event of [busy!, free!]) {
            expect(event.backgroundColor).toBe("#d62728");
            expect(event.borderColor).toBe("#d62728");
            expect(event.textColor).toBe("#ffffff");
        }
        expect(busy!.classNames).toContain("pc-accepted");
    });

    it("marks the reader's answer and the stripes for the grid's styles", () => {
        const [declined] = draw([occurrence({ myPartstat: "DECLINED" })]);
        expect(declined!.classNames).toEqual(expect.arrayContaining(["pc-declined", "pc-striped"]));
        expect((declined!.extendedProps as { stripe: string | null }).stripe).not.toBeNull();
    });

    const task = (patch: Partial<TaskItemView>): TaskItemView => ({
        source: "calendar",
        id: "t1",
        calendarId: "c1",
        title: "File taxes",
        due: "2026-10-05T09:00:00Z",
        allDay: false,
        done: false,
        reference: null,
        listName: null,
        editable: true,
        statusType: "open",
        statusColor: null,
        statusName: null,
        ...patch
    });
    const drawTasks = (tasks: TaskItemView[], showDoneTasks?: boolean) =>
        gridEvents({ occurrences: [], tasks } as unknown as RangeView, {
            zone: "UTC",
            locale: "en-US",
            now: new Date("2026-10-01T00:00:00Z"),
            showDeclined: true,
            showTasks: true,
            showDoneTasks,
            dimPast: true,
            surface: SURFACES.light,
            calendars: new Map([["c1", calendar]]),
            t: ((key: string) => key) as never
        });

    it("draws a done task struck through and faded, before its time too", () => {
        const [done] = drawTasks([task({ done: true, statusType: "done" })]);
        expect(done!.classNames).toEqual(expect.arrayContaining(["pc-task", "pc-done", "pc-past"]));
        expect(done!.backgroundColor).toBe(mix("#d62728", SURFACES.light, 0.55));
        const [open] = drawTasks([task({})]);
        expect(open!.classNames).not.toContain("pc-done");
        expect(open!.classNames).not.toContain("pc-past");
    });

    it("leaves done tasks out when completed tasks are switched off", () => {
        const tasks = [task({}), task({ id: "t2", done: true, statusType: "done" })];
        expect(drawTasks(tasks, false).map((event) => event.id)).toEqual(["task|calendar|t1"]);
        expect(drawTasks(tasks)).toHaveLength(2);
    });

    it("fades an event once it has ended, and not before", () => {
        const [ended] = draw([occurrence({})], "2026-10-05T10:00:00Z");
        const [running] = draw([occurrence({})], "2026-10-05T09:15:00Z");
        expect(ended!.classNames).toContain("pc-past");
        expect(ended!.backgroundColor).toBe(mix("#d62728", SURFACES.light, 0.55));
        expect(running!.classNames).not.toContain("pc-past");
        expect(running!.backgroundColor).toBe("#d62728");
    });
});
