// @vitest-environment jsdom

/**
 * The calendar screen's view switcher and keyboard: a view chosen by pressing
 * or by a key is drawn, written into the address and remembered; the keys move
 * the dates; and nothing fires while somebody types into a field.
 *
 * The grid itself (FullCalendar) is replaced by a stand-in that shows what it
 * was asked to draw - which is the screen's side of the contract.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { addDays } from "@polaris-app/calendar/src/screens/time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSummary } from "@polaris-app/calendar/src/lib/wire";
import { shortcutFor } from "@polaris-app/calendar/src/screens/shortcuts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_PREFERENCES, type CalendarPreferences } from "@polaris-app/calendar/src/lib/preferences";

const CALENDAR_ID = "11111111-1111-4111-8111-111111111111";
let preferences: CalendarPreferences = DEFAULT_PREFERENCES;
const savedPreferences = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
        <a href={href} {...rest}>
            {children as never}
        </a>
    )
}));

vi.mock("@polaris-app/calendar/src/screens/grid-view", () => ({
    default: (props: { view: string; anchor: string }) => <div data-testid="grid" data-view={props.view} data-anchor={props.anchor} />
}));

vi.mock("@polaris-app/calendar/src/actions/preferences", () => ({
    loadPreferencesAction: async () => ({ ok: true, preferences }),
    savePreferencesAction: async (patch: Partial<CalendarPreferences>) => {
        savedPreferences(patch);
        preferences = { ...preferences, ...patch };
        return { ok: true, preferences };
    }
}));

const calendar: CalendarSummary = {
    id: CALENDAR_ID,
    name: "Work",
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
    writable: true,
    transparent: false,
    alarmsMuted: false,
    defaultAlarms: { timed: [], allDay: [] },
    publicMode: "",
    publicToken: null,
    resource: null,
    shareCount: 0
};

vi.mock("@polaris-app/calendar/src/actions/calendars", () => ({
    listCalendarsAction: async () => ({ ok: true, calendars: [calendar] }),
    createCalendarAction: async () => ({ ok: true, calendar }),
    updateCalendarAction: async () => ({ ok: true, calendar }),
    setDisplayAction: async () => ({ ok: true }),
    reorderCalendarsAction: async () => ({ ok: true }),
    trashCalendarAction: async () => ({ ok: true }),
    leaveCalendarAction: async () => ({ ok: true })
}));
vi.mock("@polaris-app/calendar/src/actions/tasks", () => ({
    unscheduledTasksAction: async () => ({ ok: true, tasks: [] }),
    scheduleTaskAction: async () => ({ ok: true }),
    saveTodoAction: async () => ({ ok: true })
}));
vi.mock("@polaris-app/calendar/src/actions/trash", () => ({
    listTrashAction: async () => ({ ok: true, items: [], retentionDays: 30 }),
    restoreTrashAction: async () => ({ ok: true }),
    purgeTrashAction: async () => ({ ok: true }),
    emptyTrashAction: async () => ({ ok: true, removed: 0 })
}));
vi.mock("@polaris-app/calendar/src/actions/events", () => ({
    openEventAction: async () => ({ ok: false, error: "not in this test" }),
    openTodoAction: async () => ({ ok: false, error: "not in this test" }),
    saveEventAction: async () => ({ ok: true, objectId: CALENDAR_ID }),
    shiftEventAction: async () => ({ ok: true }),
    deleteEventAction: async () => ({ ok: true }),
    duplicateEventAction: async () => ({ ok: true, objectId: CALENDAR_ID }),
    respondToEventAction: async () => ({ ok: true })
}));

// Imported after the mocks it depends on are declared (vi.mock is hoisted anyway).
const { CalendarScreen } = await import("@polaris-app/calendar/src/screens/calendar-screen");

async function settle(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
}

function grid(): HTMLElement {
    return screen.getByTestId("grid");
}

function press(key: string, target: Element | Document = document.body): void {
    act(() => {
        fireEvent.keyDown(target, { key });
    });
}

beforeEach(() => {
    preferences = { ...DEFAULT_PREFERENCES, view: "week", timezone: "UTC" };
    savedPreferences.mockClear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/calendar");
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ from: "", to: "", occurrences: [], tasks: [], unreadable: 0 }), { status: 200, headers: { "content-type": "application/json" } }))
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the keyboard map", () => {
    it("maps the union of Nextcloud's and Google's keys", () => {
        const at = (key: string) => shortcutFor({ key, ctrlKey: false, metaKey: false, altKey: false, target: document.body });
        expect(at("j")).toEqual({ kind: "next" });
        expect(at("n")).toEqual({ kind: "next" });
        expect(at("k")).toEqual({ kind: "previous" });
        expect(at("3")).toEqual({ kind: "view", view: "month" });
        expect(at("a")).toEqual({ kind: "view", view: "list" });
        expect(at("x")).toEqual({ kind: "view", view: "days" });
        expect(at("?")).toEqual({ kind: "help" });
        expect(at("Delete")).toEqual({ kind: "delete" });
    });

    it("never fires while typing, nor with Ctrl, Cmd or Alt held", () => {
        const input = document.createElement("input");
        document.body.appendChild(input);
        expect(shortcutFor({ key: "m", ctrlKey: false, metaKey: false, altKey: false, target: input })).toBeNull();
        expect(shortcutFor({ key: "m", ctrlKey: true, metaKey: false, altKey: false, target: document.body })).toBeNull();
        expect(shortcutFor({ key: "m", ctrlKey: false, metaKey: true, altKey: false, target: document.body })).toBeNull();
        input.remove();
    });
});

describe("the calendar screen", () => {
    it("opens on the remembered view and switches with the view control", async () => {
        preferences = { ...preferences, view: "day" };
        render(<CalendarScreen path={[]} />, { wrapper: MessagesWrapper });
        await settle();
        expect((await screen.findByTestId("grid")).getAttribute("data-view")).toBe("day");

        fireEvent.click(screen.getByRole("radio", { name: "Month" }));
        await settle();
        expect(grid().getAttribute("data-view")).toBe("month");
        expect(window.location.pathname).toBe(`/calendar/month/${grid().getAttribute("data-anchor")}`);
        expect(savedPreferences).toHaveBeenCalledWith({ view: "month" });
    });

    it("says so when a view holds more events than were drawn", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ from: "", to: "", occurrences: [], tasks: [], unreadable: 0, truncated: true }), { status: 200, headers: { "content-type": "application/json" } }))
        );
        render(<CalendarScreen path={["year", "2026-03-14"]} />, { wrapper: MessagesWrapper });
        await settle();
        expect(await screen.findByText("Not every event fits in this view. Try a shorter one.")).toBeDefined();
    });

    it("follows the address over the remembered view", async () => {
        render(<CalendarScreen path={["year", "2026-03-14"]} />, { wrapper: MessagesWrapper });
        await settle();
        expect((await screen.findByTestId("grid")).getAttribute("data-view")).toBe("year");
        expect(grid().getAttribute("data-anchor")).toBe("2026-03-14");
    });

    it("answers the keyboard, and not while typing in the search field", async () => {
        render(<CalendarScreen path={["week", "2026-10-07"]} />, { wrapper: MessagesWrapper });
        await settle();
        await screen.findByTestId("grid");

        press("d");
        expect(grid().getAttribute("data-view")).toBe("day");
        press("j");
        expect(grid().getAttribute("data-anchor")).toBe(addDays("2026-10-07", 1));
        press("k");
        press("k");
        expect(grid().getAttribute("data-anchor")).toBe(addDays("2026-10-07", -1));
        press("2");
        expect(grid().getAttribute("data-view")).toBe("week");

        const search = screen.getByRole("combobox", { name: "Search events" });
        press("m", search);
        expect(grid().getAttribute("data-view")).toBe("week");

        press("?");
        expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeDefined();
    });

    it("ignores every key when shortcuts are switched off", async () => {
        preferences = { ...preferences, keyboardShortcuts: false };
        render(<CalendarScreen path={["week", "2026-10-07"]} />, { wrapper: MessagesWrapper });
        await settle();
        await screen.findByTestId("grid");
        press("m");
        press("j");
        expect(grid().getAttribute("data-view")).toBe("week");
        expect(grid().getAttribute("data-anchor")).toBe("2026-10-07");
    });
});
