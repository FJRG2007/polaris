// @vitest-environment jsdom

/**
 * The grid's context menu: what is under a press (an event, a time, a day, the
 * all-day row), what the menu offers on each, that a choice reaches the
 * screen's own action with the moment pressed, that a range selected first is
 * the range a new event takes, and that the keyboard opens it and steps
 * between days.
 *
 * The grid is a hand-made stand-in with FullCalendar's own markup - the classes
 * and data attributes the menu reads - so nothing here needs a layout engine.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GridRange } from "@polaris-app/calendar/src/screens/grid-view";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CalendarSummary, OccurrenceView } from "@polaris-app/calendar/src/lib/wire";
import {
    targetFromElements,
    withAncestors,
    type GridTarget
} from "@polaris-app/calendar/src/screens/grid-target";
import {
    GridMenu,
    type GridMenuActions,
    type GridMenuProps,
    type MenuTarget
} from "@polaris-app/calendar/src/screens/grid-menu";

const WORK = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";

function calendar(id: string, name: string, writable = true): CalendarSummary {
    return {
        id,
        name,
        description: "",
        color: "#1f77b4",
        ownColor: "#1f77b4",
        timezone: "",
        components: ["VEVENT"],
        kind: "local",
        source: null,
        reach: "owner",
        owner: null,
        hidden: false,
        position: 0,
        writable,
        transparent: false,
        alarmsMuted: false,
        defaultAlarms: { timed: [], allDay: [] },
        publicMode: "",
        publicToken: null,
        resource: null,
        shareCount: 0
    };
}

function occurrence(patch: Partial<OccurrenceView> = {}): OccurrenceView {
    return {
        objectId: "33333333-3333-4333-8333-333333333333",
        calendarId: WORK,
        uid: "uid-1",
        recurrenceKey: "2026-10-08T08:00:00Z",
        start: "2026-10-08T08:00:00Z",
        end: "2026-10-08T09:00:00Z",
        allDay: false,
        startDate: null,
        endDate: null,
        summary: "Budget review",
        location: "",
        color: null,
        status: null,
        transparent: false,
        recurring: false,
        overridden: false,
        kind: "default",
        attendeeCount: 0,
        myPartstat: null,
        hasAlarms: false,
        busyOnly: false,
        editable: true,
        conference: "",
        categories: [],
        ...patch
    };
}

const EVENT_ID = "event|33333333-3333-4333-8333-333333333333|2026-10-08T08:00:00Z";

/** A week of FullCalendar markup: the all-day row, the hour rows underneath,
 *  the day columns on top, one event in Thursday's column. */
function TimeGrid() {
    return (
        <div className="fc">
            <table>
                <tbody>
                    <tr className="fc-timegrid-all-day">
                        <td className="fc-daygrid-day" data-date="2026-10-07" data-testid="allday-wed" />
                        <td className="fc-daygrid-day" data-date="2026-10-08" />
                    </tr>
                </tbody>
            </table>
            <table className="fc-timegrid-slots">
                <tbody>
                    <tr>
                        <td className="fc-timegrid-slot fc-timegrid-slot-lane" data-time="09:30:00" data-testid="lane" />
                    </tr>
                </tbody>
            </table>
            <table>
                <tbody>
                    <tr className="fc-timegrid-cols">
                        <td className="fc-timegrid-col" data-date="2026-10-07" data-testid="col-wed" tabIndex={0} />
                        <td className="fc-timegrid-col" data-date="2026-10-08" data-testid="col-thu" tabIndex={-1}>
                            <a className="fc-event" data-event-id={EVENT_ID} tabIndex={0}>
                                <span data-testid="event-title">Budget review</span>
                            </a>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

function at(day: string, hhmm: string): Date {
    return new Date(`${day}T${hhmm}:00Z`);
}

/** Resolve the way the screen does, in UTC, with half-hour slots. */
function resolveLikeScreen(
    target: GridTarget,
    point: DOMRect,
    held: GridRange | null
): MenuTarget | null {
    if (target.kind === "item") {
        return target.id === EVENT_ID
            ? { kind: "event", id: target.id, occurrence: current.occurrence, rect: point }
            : null;
    }
    const start = target.allDay
        ? { at: at(target.day, "00:00"), day: target.day, allDay: true }
        : { at: at(target.day, target.time ?? "09:00"), day: target.day, allDay: false };
    const end = { ...start, at: new Date(start.at.getTime() + (target.allDay ? 86_400_000 : 1_800_000)) };
    const inside =
        held !== null &&
        held.start.allDay === start.allDay &&
        start.at >= held.start.at &&
        start.at < held.end.at;
    const range = inside ? held : { start, end };
    return {
        kind: "slot",
        range,
        day: target.day,
        selected: inside,
        when: `${target.day} ${target.time ?? ""}`.trim(),
        point
    };
}

const current = { occurrence: occurrence() };

function actions(): GridMenuActions {
    return {
        newEvent: vi.fn(),
        newAllDay: vi.fn(),
        newTask: vi.fn(),
        paste: vi.fn(),
        goToDay: vi.fn(),
        openItem: vi.fn(),
        edit: vi.fn(),
        duplicate: vi.fn(),
        copy: vi.fn(),
        move: vi.fn(),
        color: vi.fn(),
        respond: vi.fn(),
        remove: vi.fn()
    };
}

function renderMenu(patch: Partial<GridMenuProps> = {}) {
    const props: GridMenuProps = {
        children: <TimeGrid />,
        resolve: resolveLikeScreen,
        heldRange: () => null,
        onOpenChange: vi.fn(),
        calendars: [calendar(WORK, "Work"), calendar(HOME, "Home"), calendar("ro", "Team", false)],
        clipboard: null,
        taskLists: [],
        showsOnlyDay: () => false,
        actions: actions(),
        ...patch
    };
    render(<GridMenu {...props} />, { wrapper: MessagesWrapper });
    return props;
}

function rightClick(element: Element): void {
    act(() => {
        fireEvent.pointerDown(element, { button: 2, pointerType: "mouse" });
        fireEvent.contextMenu(element, { clientX: 40, clientY: 60 });
    });
}

function items(): string[] {
    return screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
}

afterEach(() => {
    cleanup();
    current.occurrence = occurrence();
});

describe("what is under a press", () => {
    it("reads an event over the column it sits in", () => {
        renderMenu();
        const found = targetFromElements(withAncestors(screen.getByTestId("event-title")));
        expect(found).toEqual({ kind: "item", id: EVENT_ID });
    });

    it("reads the day from the column and the time from the hour row beneath it", () => {
        renderMenu();
        // What the browser lists under a point of a time grid: the column on
        // top, the hour row under it.
        const found = targetFromElements([
            screen.getByTestId("col-wed"),
            screen.getByTestId("lane")
        ]);
        expect(found).toEqual({ kind: "slot", day: "2026-10-07", time: "09:30", allDay: false });
    });

    it("reads the all-day row as a whole day, and a keyboard column as a day with no time", () => {
        renderMenu();
        expect(targetFromElements(withAncestors(screen.getByTestId("allday-wed")))).toEqual({
            kind: "slot",
            day: "2026-10-07",
            time: null,
            allDay: true
        });
        expect(targetFromElements(withAncestors(screen.getByTestId("col-wed")))).toEqual({
            kind: "slot",
            day: "2026-10-07",
            time: null,
            allDay: false
        });
    });

    it("finds nothing outside the grid, so the browser keeps its own menu", () => {
        const outside = document.createElement("div");
        document.body.appendChild(outside);
        expect(targetFromElements(withAncestors(outside))).toBeNull();
        outside.remove();
    });
});

describe("the menu on a day or a time", () => {
    it("offers a new event, an all-day event, a task, and going to the day", () => {
        renderMenu();
        rightClick(screen.getByTestId("col-wed"));
        expect(items()).toEqual([
            "New event here",
            "New all-day event",
            "New task due here",
            "Go to this day"
        ]);
        expect(screen.getByText("2026-10-07")).toBeTruthy();
    });

    it("starts the new event at the moment pressed", () => {
        const props = renderMenu();
        rightClick(screen.getByTestId("col-wed"));
        fireEvent.click(screen.getByRole("menuitem", { name: "New event here" }));
        const [range] = (props.actions.newEvent as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect((range as GridRange).start).toMatchObject({ day: "2026-10-07", allDay: false });
    });

    it("takes a range selected first when the press is inside it", () => {
        const held: GridRange = {
            start: { at: at("2026-10-07", "08:00"), day: "2026-10-07", allDay: false },
            end: { at: at("2026-10-07", "11:00"), day: "2026-10-07", allDay: false }
        };
        const props = renderMenu({ heldRange: () => held });
        rightClick(screen.getByTestId("col-wed"));
        fireEvent.click(screen.getByRole("menuitem", { name: "New event in this range" }));
        expect((props.actions.newEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(held);
    });

    it("offers pasting only once something was copied, and hides tasks for who cannot make them", () => {
        renderMenu({ clipboard: occurrence({ summary: "Standup" }), taskLists: null });
        rightClick(screen.getByTestId("col-wed"));
        expect(items()).toContain("Paste StandupCtrl+V");
        expect(items()).not.toContain("New task due here");
    });

    it("shows the task item as loading while the lists are read", () => {
        renderMenu({ taskLists: undefined });
        rightClick(screen.getByTestId("col-wed"));
        const task = screen.getByRole("menuitem", { name: "New task due here" });
        expect(task.getAttribute("aria-disabled")).toBe("true");
    });

    it("leaves out going to the day the day view already shows", () => {
        renderMenu({ showsOnlyDay: (day) => day === "2026-10-07" });
        rightClick(screen.getByTestId("col-wed"));
        expect(items()).not.toContain("Go to this day");
    });
});

describe("the menu on an event", () => {
    it("offers everything that can be done with an event of one's own", () => {
        renderMenu();
        rightClick(screen.getByTestId("event-title"));
        expect(items()).toEqual([
            "Open",
            "Edit",
            "Duplicate",
            "CopyCtrl+C",
            "Move to calendar",
            "Change color",
            "Download .ics",
            "Delete"
        ]);
    });

    it("offers only reading and copying on an event that cannot be changed", () => {
        current.occurrence = occurrence({ editable: false });
        renderMenu();
        rightClick(screen.getByTestId("event-title"));
        expect(items()).toEqual(["Open", "CopyCtrl+C", "Download .ics"]);
    });

    it("offers an answer to an invitation", () => {
        current.occurrence = occurrence({ editable: false, myPartstat: "NEEDS-ACTION" });
        renderMenu();
        rightClick(screen.getByTestId("event-title"));
        expect(items()).toContain("Respond");
    });

    it("hands the chosen action the occurrence pressed", () => {
        const props = renderMenu();
        rightClick(screen.getByTestId("event-title"));
        fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(props.actions.remove).toHaveBeenCalledWith(current.occurrence);
    });
});

describe("a long press", () => {
    it("opens the menu on what is under the finger", () => {
        vi.useFakeTimers();
        try {
            renderMenu();
            const column = screen.getByTestId("col-wed");
            act(() => {
                fireEvent.pointerDown(column, { button: 0, pointerType: "touch" });
            });
            act(() => {
                vi.advanceTimersByTime(800);
            });
            expect(items()[0]).toBe("New event here");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the keyboard", () => {
    it("opens the menu on the focused day with Shift+F10", () => {
        renderMenu();
        const column = screen.getByTestId("col-wed");
        column.focus();
        act(() => {
            fireEvent.keyDown(column, { key: "F10", shiftKey: true });
        });
        expect(items()[0]).toBe("New event here");
    });

    it("opens the menu on the focused event with the menu key, and copies it with Ctrl+C", () => {
        const props = renderMenu();
        const event = screen.getByTestId("event-title").closest("a")!;
        event.focus();
        act(() => {
            fireEvent.keyDown(event, { key: "c", ctrlKey: true });
        });
        expect(props.actions.copy).toHaveBeenCalledWith(current.occurrence);
        act(() => {
            fireEvent.keyDown(event, { key: "ContextMenu" });
        });
        expect(items()[0]).toBe("Open");
    });

    it("steps to the next day with the arrows and starts an event there with Enter", () => {
        const props = renderMenu();
        const wednesday = screen.getByTestId("col-wed");
        wednesday.focus();
        act(() => {
            fireEvent.keyDown(wednesday, { key: "ArrowRight" });
        });
        const thursday = screen.getByTestId("col-thu");
        expect(document.activeElement).toBe(thursday);
        expect(thursday.tabIndex).toBe(0);
        expect(wednesday.tabIndex).toBe(-1);
        act(() => {
            fireEvent.keyDown(thursday, { key: "Enter" });
        });
        const [range] = (props.actions.newEvent as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect((range as GridRange).start.day).toBe("2026-10-08");
    });

    it("pastes onto the focused day with Ctrl+V once something was copied", () => {
        const props = renderMenu({ clipboard: occurrence() });
        const wednesday = screen.getByTestId("col-wed");
        wednesday.focus();
        act(() => {
            fireEvent.keyDown(wednesday, { key: "v", ctrlKey: true });
        });
        expect((props.actions.paste as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
            day: "2026-10-07"
        });
    });
});
