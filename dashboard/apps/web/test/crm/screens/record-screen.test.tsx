// @vitest-environment jsdom

/**
 * A record's page while it is in the trash: it says so, offers to bring the
 * record back to whoever may, shows it back at once and goes back to the
 * trash if the server refuses.
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
    restores: [] as unknown[]
}));

vi.mock("@polaris-app/crm/src/actions/records", () => ({
    openRecordAction: async () => ({
        ok: true,
        record: state.record,
        fields: [],
        can: { companies: state.can, people: state.can, opportunities: state.can },
        people: [],
        related: [],
        timeline: { events: [], next: null }
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
