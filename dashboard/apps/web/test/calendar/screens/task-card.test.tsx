// @vitest-environment jsdom

/**
 * A task on the calendar, as Tasks draws one and Google's calendar handles one.
 *
 * The report: a Google task on the calendar was a coloured bar and nothing
 * else - no way to tell it apart from an event, tick it off, or do anything
 * with it but open a form. Now it wears Tasks' own round status mark, the mark
 * ticks it off, and pressing it opens a card that edits, copies, downloads or
 * deletes it - or, for a Tasks task, opens it in Tasks.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskItemView } from "@polaris-app/calendar/src/lib/wire";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskCard, TaskMark } from "@polaris-app/calendar/src/screens/task-card";

afterEach(cleanup);

const GOOGLE: TaskItemView = {
    source: "calendar",
    id: "11111111-1111-4111-8111-111111111111",
    calendarId: "22222222-2222-4222-8222-222222222222",
    title: "Pay rent",
    due: "2026-10-20T00:00:00.000Z",
    allDay: true,
    done: false,
    reference: null,
    listName: null,
    editable: true,
    statusType: "open",
    statusColor: null,
    statusName: null
};

const CALENDAR = {
    id: GOOGLE.calendarId!,
    name: "My tasks",
    color: "#1a73e8"
} as never;

function card(task: TaskItemView, handlers: Partial<Record<string, () => void>> = {}) {
    const props = {
        onClose: vi.fn(),
        onToggle: vi.fn(),
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        ...handlers
    };
    render(
        <TaskCard
            task={task}
            calendar={task.source === "calendar" ? CALENDAR : undefined}
            anchor={null}
            zone="Europe/Madrid"
            locale="en-US"
            {...props}
        />,
        { wrapper: MessagesWrapper }
    );
    return props;
}

describe("a task's mark", () => {
    it("is Tasks' round mark, and ticks the task off when pressed", () => {
        const onToggle = vi.fn();
        const { container } = render(
            <TaskMark task={GOOGLE} color="#1a73e8" onToggle={onToggle} />,
            {
                wrapper: MessagesWrapper
            }
        );
        expect(container.querySelector("svg circle")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
        expect(onToggle).toHaveBeenCalledWith(GOOGLE);
    });

    it("offers to undo a done one, and is only a picture where it cannot be changed", () => {
        render(
            <TaskMark
                task={{ ...GOOGLE, done: true, statusType: "done" }}
                color="#000"
                onToggle={vi.fn()}
            />,
            {
                wrapper: MessagesWrapper
            }
        );
        expect(screen.getByRole("button", { name: "Mark as not done" })).toBeTruthy();
        cleanup();
        render(<TaskMark task={{ ...GOOGLE, editable: false }} color="#000" onToggle={vi.fn()} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("the card of a calendar's task", () => {
    it("edits, copies, downloads and deletes it, as Google's does", () => {
        const props = card(GOOGLE);
        expect(screen.getAllByText("Pay rent").length).toBeGreaterThan(0);
        expect(screen.getByText("Not started")).toBeTruthy();
        expect(screen.getByText("My tasks")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
        fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
        fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
        expect(props.onEdit).toHaveBeenCalledTimes(1);
        expect(props.onDuplicate).toHaveBeenCalledTimes(1);
        expect(props.onDelete).toHaveBeenCalledTimes(1);
        expect(props.onToggle).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("link", { name: "Download .ics" }).getAttribute("href")).toBe(
            `/api/calendar/export/event/${GOOGLE.id}`
        );
    });

    it("only opens one it cannot change", () => {
        card({ ...GOOGLE, editable: false });
        expect(screen.getByRole("button", { name: /Open/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete task" })).toBeNull();
    });
});

describe("the card of a Tasks task", () => {
    it("names its status and opens it in Tasks", () => {
        const props = card({
            ...GOOGLE,
            source: "tasks",
            calendarId: null,
            reference: "ENG-42",
            listName: "Sprint",
            statusType: "active",
            statusColor: "#3b82f6",
            statusName: "In review"
        });
        expect(screen.getByText("In review")).toBeTruthy();
        expect(screen.getByText("Sprint")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: /Open in Tasks/ }));
        expect(props.onEdit).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    });
});
