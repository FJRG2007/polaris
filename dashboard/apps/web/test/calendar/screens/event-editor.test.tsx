// @vitest-environment jsdom

/**
 * The event editor's Save is enabled only when what would be sent differs from
 * what was loaded - a title changed and changed back leaves it off - and the
 * reason it is off is on the button. It stays reachable (aria-disabled, not
 * disabled) so the reason can be read.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import * as engine from "@polaris-app/calendar/src/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EventEditor } from "@polaris-app/calendar/src/screens/event-editor";
import { DEFAULT_PREFERENCES } from "@polaris-app/calendar/src/lib/preferences";
import type { CalendarSummary, EventDetail } from "@polaris-app/calendar/src/lib/wire";

const CALENDAR_ID = "11111111-1111-4111-8111-111111111111";
const OBJECT_ID = "22222222-2222-4222-8222-222222222222";

const saved = vi.fn();

vi.mock("@polaris-app/calendar/src/actions/events", () => ({
    openEventAction: async () => ({ ok: true, detail }),
    openTodoAction: async () => ({ ok: false, error: "no" }),
    saveEventAction: async (input: unknown) => {
        saved(input);
        return { ok: true, objectId: OBJECT_ID };
    },
    shiftEventAction: async () => ({ ok: true }),
    deleteEventAction: async () => ({ ok: true }),
    duplicateEventAction: async () => ({ ok: true, objectId: OBJECT_ID }),
    respondToEventAction: async () => ({ ok: true })
}));

vi.mock("@polaris-app/calendar/src/actions/meeting", () => ({
    createMeetingLinkAction: async () => ({ ok: true, link: "https://example.test/meet/1" })
}));

const event = engine.newEvent({
    uid: "fixture-standup@example.test",
    summary: "Standup",
    start: { dateTime: "2026-10-05T10:00:00", tzid: "Europe/Madrid" },
    end: { dateTime: "2026-10-05T10:30:00", tzid: "Europe/Madrid" }
});

const detail: EventDetail = {
    objectId: OBJECT_ID,
    calendarId: CALENDAR_ID,
    recurrenceKey: null,
    version: "2026-09-30T10:00:00.000Z",
    event,
    series: event,
    writable: true,
    answerable: true,
    isOrganizer: true,
    myEmails: [],
    invitations: [],
    conflict: false,
    pending: false,
    busyOnly: false
};

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

function renderEditor() {
    return render(
        <EventEditor
            target={{ kind: "open", objectId: OBJECT_ID, recurrenceKey: null }}
            onClose={() => undefined}
            calendars={[calendar]}
            zone="Europe/Madrid"
            preferences={DEFAULT_PREFERENCES}
            onChanged={() => undefined}
            onOpen={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

beforeEach(() => saved.mockClear());
afterEach(cleanup);

describe("the event editor's Save", () => {
    it("is off until something differs from what was loaded, and says why", async () => {
        renderEditor();
        const title = await screen.findByRole("textbox", { name: "Title" });
        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        expect(save.getAttribute("title")).toBe("Nothing has changed");
        expect(save.hasAttribute("disabled")).toBe(false);

        fireEvent.change(title, { target: { value: "Standup, moved" } });
        expect(save.getAttribute("aria-disabled")).toBe("false");

        // Put back as it was: nothing differs, so nothing to save.
        fireEvent.change(title, { target: { value: "Standup" } });
        expect(save.getAttribute("aria-disabled")).toBe("true");
    });

    it("treats an emptied required field as incomplete, not as an error, and does not send", async () => {
        renderEditor();
        await screen.findByRole("textbox", { name: "Title" });
        const start = screen.getByLabelText("Starts");
        fireEvent.change(start, { target: { value: "" } });
        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        expect(save.getAttribute("title")).toBe("Fill in the required fields");
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.click(save);
        expect(saved).not.toHaveBeenCalled();
    });

    it("names a real problem under its field", async () => {
        renderEditor();
        await screen.findByRole("textbox", { name: "Title" });
        fireEvent.change(screen.getByLabelText("Web page"), { target: { value: "not a link" } });
        expect(screen.getByRole("alert").textContent).toBe("Use a link starting with https://.");
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("title")).toBe(
            "Fix the fields marked in red"
        );
    });

    it("saves with Ctrl+S once something changed", async () => {
        renderEditor();
        const title = await screen.findByRole("textbox", { name: "Title" });
        fireEvent.change(title, { target: { value: "Retro" } });
        fireEvent.keyDown(title, { key: "s", ctrlKey: true });
        await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
        const input = saved.mock.calls[0]![0] as {
            objectId: string;
            scope: string;
            event: { summary: string; calendarId: string };
        };
        expect(input.objectId).toBe(OBJECT_ID);
        expect(input.scope).toBe("all");
        expect(input.event.summary).toBe("Retro");
        expect(input.event.calendarId).toBe(CALENDAR_ID);
    });
});
