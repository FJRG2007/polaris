// @vitest-environment jsdom

/**
 * The card a click on the grid opens: Google's Event | Task | Appointment
 * schedule switch at its top, a task made from it through the same creation as
 * "New task due here" (the list used last, due at the moment picked, timed or
 * all-day), "More details" opening the task in Tasks, a booking page offered
 * only while booking pages are on, and Task gone when the account cannot make
 * tasks.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSummary } from "@polaris-app/calendar/src/lib/wire";
import type { GridMoment } from "@polaris-app/calendar/src/screens/grid-view";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })
}));
vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
        <a href={href} {...rest}>
            {children as never}
        </a>
    )
}));

const LIST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let lists: { id: string; name: string; spaceName: string }[] | null = [];
let allowBooking = true;
const created = vi.fn();

vi.mock("@polaris-app/calendar/src/actions/tasks", () => ({
    taskListsAction: async () => ({ ok: true, lists }),
    createDueTaskAction: async (input: unknown) => {
        created(input);
        return { ok: true, taskId: "t-1", reference: "OPS-7" };
    },
    unscheduledTasksAction: async () => ({ ok: true, tasks: [] }),
    scheduleTaskAction: async () => ({ ok: true }),
    saveTodoAction: async () => ({ ok: true })
}));
vi.mock("@polaris-app/calendar/src/actions/instance", () => ({
    loadInstanceSettingsAction: async () => ({
        ok: true,
        settings: { allowSubscriptions: true, allowBooking, suggested: [] },
        canManage: false
    })
}));
vi.mock("@polaris-app/calendar/src/actions/booking", () => ({
    linkBaseAction: async () => ({ ok: true, base: "https://polaris.example.test" }),
    listBookingPagesAction: async () => ({ ok: true, pages: [] })
}));
vi.mock("@polaris-app/calendar/src/actions/events", () => ({
    openEventAction: async () => ({ ok: false, error: "not in this test" })
}));

const { NewEventCard } = await import("@polaris-app/calendar/src/screens/event-popover");
const { NewTaskDialog } = await import("@polaris-app/calendar/src/screens/new-task-dialog");
const { dropCached } = await import("@polaris-app/calendar/src/screens/cached-read");

const calendar = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Work",
    color: "#1f77b4",
    components: ["VEVENT"],
    writable: true,
    hidden: false
} as unknown as CalendarSummary;

const TIMED: GridMoment = {
    at: new Date("2026-10-05T08:00:00Z"),
    day: "2026-10-05",
    allDay: false
};
const ALL_DAY: GridMoment = {
    at: new Date("2026-10-05T00:00:00Z"),
    day: "2026-10-05",
    allDay: true
};

async function settle(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
}

function Card({
    start = TIMED,
    summary = "",
    onTaskCreated = vi.fn(),
    onBooking = vi.fn(),
    onSave = vi.fn()
}: {
    start?: GridMoment;
    summary?: string;
    onTaskCreated?: (task: unknown, open: boolean) => void;
    onBooking?: () => void;
    onSave?: () => void;
}) {
    return (
        <NewEventCard
            anchor={null}
            start={start}
            when="Mon, Oct 5, 2026, 8:00 - 9:00 AM"
            zone="UTC"
            locale="en-US"
            calendars={[calendar]}
            calendarId={calendar.id}
            onCalendar={() => undefined}
            summary={summary}
            onSummary={() => undefined}
            busy={false}
            onSave={onSave}
            onMore={() => undefined}
            onTaskCreated={onTaskCreated}
            onBooking={onBooking}
            onClose={() => undefined}
        />
    );
}

/** A storage of its own: the test environment's may be missing or shared. */
function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, String(value))
    };
}

beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    lists = [
        { id: LIST_A, name: "Inbox", spaceName: "Ops" },
        { id: LIST_B, name: "Errands", spaceName: "Home" }
    ];
    allowBooking = true;
    created.mockClear();
    sessionStorage.clear();
    dropCached("task-lists");
    dropCached("booking-switch");
});

afterEach(() => cleanup());

describe("the quick-create card", () => {
    it("offers Event, Task and Booking page at the top, moved between with the arrow keys", async () => {
        render(<Card />, { wrapper: MessagesWrapper });
        await settle();
        const group = screen.getByRole("radiogroup", { name: "What to create" });
        const radios = screen.getAllByRole("radio");
        expect(radios.map((radio) => radio.textContent)).toEqual(["Event", "Task", "Booking page"]);
        expect(group.compareDocumentPosition(screen.getByRole("textbox"))).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING
        );
        expect(radios[0]!.getAttribute("aria-checked")).toBe("true");

        act(() => {
            fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
        });
        await settle();
        expect(screen.getByRole("radio", { name: "Task" }).getAttribute("aria-checked")).toBe(
            "true"
        );
        expect(screen.getByText("Due Monday, October 5, 2026 at 8:00 AM")).toBeDefined();
    });

    it("makes a timed task due at the moment picked, in the list used last", async () => {
        localStorage.setItem("polaris.calendar.task-list", LIST_B);
        const onTaskCreated = vi.fn();
        render(<Card summary="  Buy stamps " onTaskCreated={onTaskCreated} />, {
            wrapper: MessagesWrapper
        });
        await settle();
        fireEvent.click(screen.getByRole("radio", { name: "Task" }));
        await settle();
        expect(screen.getByRole("combobox", { name: "List" }).textContent).toContain(
            "Home / Errands"
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await settle();
        expect(created).toHaveBeenCalledWith({
            listId: LIST_B,
            name: "Buy stamps",
            due: { at: "2026-10-05T08:00:00.000Z", timed: true }
        });
        expect(onTaskCreated).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: "t-1", reference: "OPS-7" }),
            false
        );
        expect(localStorage.getItem("polaris.calendar.task-list")).toBe(LIST_B);
    });

    it("makes an all-day task from a day, and opens it in Tasks from More details", async () => {
        const onTaskCreated = vi.fn();
        render(<Card start={ALL_DAY} summary="Renew passport" onTaskCreated={onTaskCreated} />, {
            wrapper: MessagesWrapper
        });
        await settle();
        fireEvent.click(screen.getByRole("radio", { name: "Task" }));
        await settle();
        fireEvent.click(screen.getByRole("button", { name: "More details" }));
        await settle();
        expect(created).toHaveBeenCalledWith({
            listId: LIST_A,
            name: "Renew passport",
            due: { at: "2026-10-05T00:00:00.000Z", timed: false }
        });
        expect(onTaskCreated).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: "t-1", reference: "OPS-7" }),
            true
        );
    });

    it("holds a task with no title, and says why", async () => {
        render(<Card summary="   " />, { wrapper: MessagesWrapper });
        await settle();
        fireEvent.click(screen.getByRole("radio", { name: "Task" }));
        await settle();
        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        expect(save.getAttribute("title")).toBe("Add a title first");
        fireEvent.click(save);
        await settle();
        expect(created).not.toHaveBeenCalled();
    });

    it("leaves Task out for an account that cannot make tasks, and the switch with it", async () => {
        lists = null;
        allowBooking = false;
        render(<Card />, { wrapper: MessagesWrapper });
        await settle();
        expect(screen.queryByRole("radiogroup")).toBeNull();
        expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    });

    it("offers a booking page only while they are switched on, and goes on to one", async () => {
        const onBooking = vi.fn();
        render(<Card summary="Office hours" onBooking={onBooking} />, { wrapper: MessagesWrapper });
        await settle();
        fireEvent.click(screen.getByRole("radio", { name: "Booking page" }));
        await settle();
        fireEvent.click(screen.getByRole("button", { name: "Set up page" }));
        expect(onBooking).toHaveBeenCalledTimes(1);
        cleanup();

        allowBooking = false;
        dropCached("booking-switch");
        render(<Card />, { wrapper: MessagesWrapper });
        await settle();
        expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
            "Event",
            "Task"
        ]);
    });
});

describe("New task due here", () => {
    it("makes the task through the same creation as the card", async () => {
        const onCreated = vi.fn();
        render(
            <NewTaskDialog
                at={TIMED}
                zone="UTC"
                locale="en-US"
                onClose={() => undefined}
                onCreated={onCreated}
            />,
            { wrapper: MessagesWrapper }
        );
        await settle();
        fireEvent.change(screen.getByRole("textbox", { name: "Name *" }), {
            target: { value: "File the report" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Create task" }));
        await settle();
        expect(created).toHaveBeenCalledWith({
            listId: LIST_A,
            name: "File the report",
            due: { at: "2026-10-05T08:00:00.000Z", timed: true }
        });
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({ taskId: "t-1", reference: "OPS-7" })
        );
    });
});
