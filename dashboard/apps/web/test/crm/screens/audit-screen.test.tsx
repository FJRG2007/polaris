// @vitest-environment jsdom

/**
 * The audit log screen: each event with what happened, the record it happened
 * to (a link while it exists), who and when, the fields it changed; older
 * events on request; and a role that reaches no kind of record in full told
 * where its history is instead.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const state = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], objects: ["companies"] as string[] }));

vi.mock("@polaris-app/crm/src/actions/audit", () => ({
    auditAction: async (input: Record<string, unknown>) => {
        state.calls.push(input);
        const older = Boolean(input.cursor);
        return {
            ok: true,
            objects: state.objects,
            people: [{ id: "u1", name: "Test User" }],
            fields: { companies: [] },
            next: older ? null : ID(1),
            events: state.objects.length === 0
                ? []
                : older
                  ? [
                        {
                            id: ID(1),
                            object: "companies",
                            recordId: ID(10),
                            recordName: null,
                            kind: "trashed",
                            actor: null,
                            at: "2026-10-12T10:00:00.000Z",
                            changes: []
                        }
                    ]
                  : [
                        {
                            id: ID(2),
                            object: "companies",
                            recordId: ID(11),
                            recordName: "Example Co",
                            kind: "updated",
                            actor: { id: "u1", name: "Test User" },
                            at: "2026-10-13T10:00:00.000Z",
                            changes: [{ key: "city", before: "Old Town", after: "New Town" }]
                        }
                    ]
        };
    },
    exportAuditAction: async () => ({ ok: true, csv: "", rows: 0, truncated: false })
}));

import { AuditScreen } from "@polaris-app/crm/src/screens/audit-screen";

beforeEach(() => {
    state.calls = [];
    state.objects = ["companies"];
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
    if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(cleanup);

describe("audit log", () => {
    it("lists events with the record linked, who, and the fields changed, and reads older ones", async () => {
        render(<AuditScreen />, { wrapper: MessagesWrapper });
        const link = await screen.findByRole("link", { name: "Example Co" });
        expect(link.getAttribute("href")).toBe(`/crm/companies/${ID(11)}`);
        expect(screen.getByText("Changed")).toBeTruthy();
        expect(screen.getByText("New Town")).toBeTruthy();
        expect(screen.getAllByText("Test User").length).toBeGreaterThan(0);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show older" }));
        });
        expect(await screen.findByText("Deleted record")).toBeTruthy();
        expect(state.calls[state.calls.length - 1]).toMatchObject({ cursor: ID(1) });
        expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    });

    it("tells a role held to its own records where the history is", async () => {
        state.objects = [];
        render(<AuditScreen />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(/Each record's own activity is on its page/)).toBeTruthy();
        expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
    });
});
