// @vitest-environment jsdom

/**
 * A record's page. While it is in the trash it says so, offers to bring the
 * record back to whoever may, shows it back at once and goes back to the
 * trash if the server refuses. Its notes and tasks are listed, a note is
 * written from it, and a task ticked off shows at once and goes back when the
 * server refuses.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import type { CrmRecord } from "@polaris-app/crm/src/model/objects";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ACME = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
    record: null as CrmRecord | null,
    can: { read: true, edit: true, delete: true },
    refuse: false,
    restores: [] as unknown[],
    notes: [] as unknown[],
    tasks: [] as { id: string; name: string; done: boolean }[],
    refuseTick: false,
    madeNotes: [] as unknown[],
    ticks: [] as unknown[],
    favorite: false,
    pins: [] as unknown[],
    refusePin: false
}));

vi.mock("@polaris-app/crm/src/actions/favorites", () => ({
    setFavoriteAction: async (input: { pinned: boolean }) => {
        state.pins.push(input);
        if (state.refusePin) return { ok: false, error: "You already have 50 favorites here." };
        return { ok: true, pinned: input.pinned };
    }
}));

vi.mock("@polaris-app/crm/src/actions/activities", () => ({
    recordActivitiesAction: async () => ({
        ok: true,
        activities: {
            notes: state.notes,
            noteShelves: [{ id: null, name: "" }],
            tasks: state.tasks.map((task) => ({
                ...task,
                reference: "T-1",
                due: null,
                listName: "Sales"
            })),
            taskLists: [
                { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Sales", spaceName: "Team" }
            ]
        }
    }),
    createRecordNoteAction: async (input: { note: { title: string } }) => {
        state.madeNotes.push(input);
        const note = {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            title: input.note.title,
            excerpt: "",
            updatedAt: "2026-10-01T10:00:00.000Z"
        };
        state.notes = [note, ...state.notes];
        return { ok: true, note };
    },
    createRecordTaskAction: vi.fn(),
    setRecordTaskDoneAction: async (input: unknown) => {
        state.ticks.push(input);
        return state.refuseTick
            ? { ok: false, error: "Not yours to change." }
            : { ok: true, done: true };
    },
    unlinkAction: vi.fn()
}));

vi.mock("@polaris-app/crm/src/actions/records", () => ({
    openRecordAction: async () => ({
        ok: true,
        record: state.record,
        fields: [],
        can: { companies: state.can, people: state.can, opportunities: state.can },
        people: [],
        related: [],
        timeline: { events: [], next: null },
        favorite: state.favorite
    }),
    restoreRecordsAction: async (input: unknown) => {
        state.restores.push(input);
        if (state.refuse) return { ok: false, error: "Your role cannot delete companies here." };
        state.record = { ...state.record!, deletedAt: null };
        return { ok: true, count: 1 };
    },
    recordTimelineAction: async () => ({ ok: true, events: [], next: null }),
    updateRecordAction: vi.fn(),
    searchRefsAction: async () => ({ ok: true, refs: [] })
}));

import { RecordScreen } from "@polaris-app/crm/src/screens/record-screen";

beforeEach(() => {
    state.record = {
        id: ACME,
        position: 0,
        deletedAt: "2026-10-01T10:00:00.000Z",
        values: { name: "Acme", city: "Madrid" }
    };
    state.can = { read: true, edit: true, delete: true };
    state.refuse = false;
    state.restores = [];
    state.notes = [];
    state.tasks = [];
    state.refuseTick = false;
    state.madeNotes = [];
    state.ticks = [];
    state.favorite = false;
    state.pins = [];
    state.refusePin = false;
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
    if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(cleanup);

const notice = "This record is in the trash and cannot be changed.";

describe("a record in the trash", () => {
    it("is restored from its own page", async () => {
        render(<RecordScreen object="companies" id={ACME} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(notice)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        });
        expect(screen.queryByText(notice)).toBeNull();
        await waitFor(() => expect(state.restores).toEqual([{ object: "companies", ids: [ACME] }]));
        expect(screen.queryByText(notice)).toBeNull();
    });

    it("goes back to the trash when the server refuses", async () => {
        state.refuse = true;
        render(<RecordScreen object="companies" id={ACME} />, { wrapper: MessagesWrapper });
        await screen.findByText(notice);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        });
        await waitFor(() => expect(state.restores).toHaveLength(1));
        expect(await screen.findByText(notice)).toBeTruthy();
    });

    it("offers no restore to somebody who may not delete", async () => {
        state.can = { read: true, edit: true, delete: false };
        render(<RecordScreen object="companies" id={ACME} />, { wrapper: MessagesWrapper });
        await screen.findByText(notice);
        expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    });
});

describe("pinning a record", () => {
    beforeEach(() => {
        state.record = { ...state.record!, deletedAt: null };
    });

    it("pins it to the rail with the star, and unpins it the same way", async () => {
        state.favorite = true;
        render(<RecordScreen object="companies" id={ACME} />, { wrapper: MessagesWrapper });
        const star = await screen.findByRole("button", { name: "Remove from favorites" });
        expect(star.getAttribute("aria-pressed")).toBe("true");
        await act(async () => {
            fireEvent.click(star);
        });
        await waitFor(() =>
            expect(state.pins).toEqual([
                { kind: "record", object: "companies", targetId: ACME, pinned: false }
            ])
        );
        expect(screen.getByRole("button", { name: "Add to favorites" })).toBeTruthy();
    });

    it("puts the star back when the pin is refused", async () => {
        state.refusePin = true;
        state.favorite = true;
        render(<RecordScreen object="companies" id={ACME} />, { wrapper: MessagesWrapper });
        const star = await screen.findByRole("button", { name: "Remove from favorites" });
        await act(async () => {
            fireEvent.click(star);
        });
        await waitFor(() => expect(state.pins).toHaveLength(1));
        expect(await screen.findByRole("button", { name: "Remove from favorites" })).toBeTruthy();
    });
});

describe("notes and tasks on a record", () => {
    beforeEach(() => {
        state.record = { ...state.record!, deletedAt: null };
    });

    it("writes a note from the record and lists it", async () => {
        render(<RecordScreen object="companies" id={ACME} />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("No notes yet")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add note" }));
        const add = screen.getByRole("button", { name: "Add" });
        expect(add.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(screen.getByRole("textbox", { name: "Title *" }), {
            target: { value: "  Kickoff call " }
        });
        expect(add.getAttribute("aria-disabled")).toBe("false");
        await act(async () => {
            fireEvent.click(add);
        });
        expect(await screen.findByText("Kickoff call")).toBeTruthy();
        expect(state.madeNotes).toEqual([
            {
                object: "companies",
                id: ACME,
                note: { title: "  Kickoff call ", body: "", spaceId: null }
            }
        ]);
    });

    it("puts a task back when ticking it off is refused", async () => {
        state.tasks = [
            { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Call back", done: false }
        ];
        state.refuseTick = true;
        render(<RecordScreen object="companies" id={ACME} />, { wrapper: MessagesWrapper });
        const box = await screen.findByRole("checkbox", { name: "Mark Call back done" });
        await act(async () => {
            fireEvent.click(box);
        });
        const ticked = () => {
            const now = screen.getByRole("checkbox", { name: "Mark Call back done" });
            return now.getAttribute("aria-checked") ?? String((now as HTMLInputElement).checked);
        };
        await waitFor(() => expect(state.ticks).toHaveLength(1));
        expect(state.ticks[0]).toMatchObject({ done: true });
        await waitFor(() => expect(ticked()).toBe("false"));
    });
});
