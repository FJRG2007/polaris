/**
 * The calendar as it is actually drawn.
 *
 * A smoke test with teeth: it renders the real view and asserts the two things
 * the rewrite is for - the week begins on the day the account chose, and the
 * grid is seven whole columns of it - plus that a dated task lands in the month
 * at all. Rendering it is also what catches a hook or an import that only fails
 * once the component runs.
 */

import { vi, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import type { ViewProps } from "@/app/(app)/tasks/views/shared";
import { DisplayFormatProvider } from "@/components/display-format";
import { DISPLAY_DEFAULTS, type DisplayPreferences } from "@polaris/core";

// The events feed is a network call the view makes on mount; the calendar has to
// draw its tasks whether or not anybody has linked a calendar.
vi.mock("@/lib/google-calendar/events-client", () => ({
    useGoogleCalendarEvents: () => ({ status: "unlinked", events: [], error: null })
}));

const { CalendarView } = await import("@/app/(app)/tasks/views/calendar");

const CONTEXT: SpaceContext = {
    spaceId: "s1",
    statuses: [],
    tags: [],
    fields: [],
    people: [],
    canEdit: true,
    canModerate: false,
    currentUserId: "u1",
    siblings: []
};

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id: "t1",
        reference: "FJRG-1",
        name: "Review the quarter",
        description: "",
        spaceId: "s1",
        spaceName: "Space",
        listId: "l1",
        listName: "List",
        folderName: null,
        parentId: null,
        statusId: "st1",
        statusName: "Open",
        statusColor: "#64748b",
        statusType: "open",
        priority: "none",
        assignees: [],
        tags: [],
        createdById: null,
        startDate: null,
        dueDate: null,
        timed: false,
        timeEstimate: null,
        points: null,
        milestone: false,
        archived: false,
        order: 1,
        sprintId: null,
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: false,
        blockedUntil: null,
        blockedNote: "",
        recurring: false,
        customValues: {},
        ...overrides
    };
}

function props(rows: TaskRow[]): ViewProps {
    return {
        rows,
        groups: [],
        context: CONTEXT,
        canEdit: true,
        orderable: true,
        selection: new Set<string>(),
        selected: [],
        lists: [],
        onOpen: () => {},
        onSelect: () => {},
        onMove: () => {},
        onQuickCreate: () => {},
        onEdit: () => {},
        onApply: () => {},
        onDuplicate: () => {},
        onDelete: () => {}
    };
}

function render(rows: TaskRow[], preferences: DisplayPreferences): string {
    return renderToStaticMarkup(
        <DisplayFormatProvider preferences={preferences}>
            <CalendarView {...props(rows)} />
        </DisplayFormatProvider>
    );
}

/** The weekday headings, in the order the grid drew them. */
function headings(markup: string): string[] {
    return [...markup.matchAll(/>(Sun|Mon|Tue|Wed|Thu|Fri|Sat)</g)].map((match) => match[1] as string);
}

describe("the calendar grid", () => {
    it("starts the week on Sunday by default", () => {
        const week = headings(render([], DISPLAY_DEFAULTS));
        expect(week.slice(0, 7)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    });

    it("starts it where the account said instead", () => {
        expect(headings(render([], { ...DISPLAY_DEFAULTS, weekStart: "mon" })).slice(0, 7)).toEqual([
            "Mon",
            "Tue",
            "Wed",
            "Thu",
            "Fri",
            "Sat",
            "Sun"
        ]);
        expect(headings(render([], { ...DISPLAY_DEFAULTS, weekStart: "sat" })).slice(0, 7)).toEqual([
            "Sat",
            "Sun",
            "Mon",
            "Tue",
            "Wed",
            "Thu",
            "Fri"
        ]);
    });

    it("offers all three scopes and draws a task due this month", () => {
        const today = new Date();
        const due = new Date(today.getFullYear(), today.getMonth(), 15, 10, 0).toISOString();
        const markup = render([taskRow({ dueDate: due })], DISPLAY_DEFAULTS);
        expect(markup).toContain("Review the quarter");
        for (const scope of ["Day", "Week", "Month"]) expect(markup).toContain(`>${scope}<`);
    });

    it("says how many tasks it could not place rather than inventing a day for them", () => {
        const markup = render([taskRow()], DISPLAY_DEFAULTS);
        expect(markup).toContain("1 task has no dates");
    });
});
