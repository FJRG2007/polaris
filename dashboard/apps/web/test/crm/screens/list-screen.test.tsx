// @vitest-environment jsdom

/**
 * A CRM list as somebody uses it: the rows the server answers are drawn, a cell
 * edited in place shows its new value at once and keeps it once the server
 * agrees, goes back when the server refuses, a new record is typed into the
 * top row, and a reader without the right to change records is offered nothing
 * that would change one. A view drawn as a board has a column per stage and
 * moves a card; the list can be saved as a new named view, and a filter reads
 * the list again once its rule is whole.
 *
 * The actions are replaced by an in-memory stand-in that answers the way the
 * real ones do.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { defaultConfig, type ViewSummary } from "@polaris-app/crm/src/model/views";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmRecord, FieldValue } from "@polaris-app/crm/src/model/objects";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const VIEW_ID = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const GLOBEX = "33333333-3333-4333-8333-333333333333";

const company = (id: string, name: string, city: string): CrmRecord => ({
    id,
    position: 0,
    deletedAt: null,
    values: { name, city, domain: "", employees: null, createdAt: "2026-10-01T10:00:00.000Z" }
});

const state = vi.hoisted(() => ({
    rows: [] as CrmRecord[],
    can: { read: true, edit: true, delete: true },
    refuseUpdate: false,
    updates: [] as unknown[],
    creates: [] as unknown[],
    lists: [] as unknown[],
    moves: [] as unknown[],
    madeViews: [] as unknown[],
    /** The views the list opens with; null is only the default table. */
    views: null as ViewSummary[] | null,
    groups: [] as { value: string; records: CrmRecord[]; total: number }[]
}));

vi.mock("@polaris-app/crm/src/actions/records", () => {
    const abilities = () => ({
        companies: state.can,
        people: state.can,
        opportunities: state.can
    });
    return {
        openListAction: async () => {
            const views = state.can.read
                ? (state.views ?? [
                      {
                          id: VIEW_ID,
                          name: "",
                          kind: "table",
                          config: defaultConfig("companies")
                      }
                  ])
                : [];
            return {
                ok: true,
                view: views[0] ?? null,
                views,
                can: abilities(),
                people: [],
                shelfName: null
            };
        },
        listRecordsAction: async (input: unknown) => {
            state.lists.push(input);
            return { ok: true, records: state.rows, total: state.rows.length };
        },
        listGroupsAction: async () => ({ ok: true, groups: state.groups }),
        moveRecordAction: async (input: { id: string; value: string }) => {
            state.moves.push(input);
            const row = state.groups.flatMap((group) => group.records).find((one) => one.id === input.id)!;
            return { ok: true, record: { ...row, values: { ...row.values, stage: input.value } } };
        },
        createViewAction: async (input: { name: string; kind: "table" | "kanban"; config: never }) => {
            state.madeViews.push(input);
            return {
                ok: true,
                view: {
                    id: "55555555-5555-4555-8555-555555555555",
                    name: input.name,
                    kind: input.kind,
                    config: input.config
                }
            };
        },
        renameViewAction: vi.fn(),
        deleteViewAction: vi.fn(),
        totalsAction: async () => ({
            ok: true,
            totals: [{ key: "name", aggregate: "countAll", value: state.rows.length }]
        }),
        updateRecordAction: async (input: { id: string; values: Record<string, FieldValue> }) => {
            state.updates.push(input);
            if (state.refuseUpdate)
                return { ok: false, error: "Your role cannot change companies here." };
            const row = state.rows.find((one) => one.id === input.id)!;
            const record = { ...row, values: { ...row.values, ...input.values } };
            state.rows = state.rows.map((one) => (one.id === input.id ? record : one));
            return { ok: true, record };
        },
        createRecordAction: async (input: { values: Record<string, unknown> }) => {
            state.creates.push(input);
            const record = {
                id: "44444444-4444-4444-8444-444444444444",
                position: -1,
                deletedAt: null,
                values: { ...input.values, city: "" }
            };
            state.rows = [record as CrmRecord, ...state.rows];
            return { ok: true, record };
        },
        updateRecordsAction: vi.fn(),
        trashRecordsAction: vi.fn(),
        searchRefsAction: async () => ({ ok: true, refs: [] }),
        saveViewAction: async () => ({ ok: true })
    };
});

import { ListScreen } from "@polaris-app/crm/src/screens/list-screen";

beforeEach(() => {
    state.rows = [company(ACME, "Acme", "Madrid"), company(GLOBEX, "Globex", "Lisbon")];
    state.can = { read: true, edit: true, delete: true };
    state.refuseUpdate = false;
    state.updates = [];
    state.creates = [];
    state.lists = [];
    state.moves = [];
    state.madeViews = [];
    state.views = null;
    state.groups = [];
    if (typeof localStorage !== "undefined") localStorage.clear();
    // What the tab kept from the last test would paint before the read.
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
    // jsdom has no layout, so nothing ever scrolls into sight.
    globalThis.IntersectionObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
        takeRecords() {
            return [];
        }
        root = null;
        rootMargin = "";
        thresholds = [];
    } as unknown as typeof IntersectionObserver;
});

afterEach(cleanup);

const cityCell = (name: string) => {
    const row = screen.getByText(name).closest("tr")!;
    return [...row.querySelectorAll("td")].find(
        (cell) => cell.getAttribute("aria-label") === "City"
    )!;
};

describe("a CRM list", () => {
    it("draws the rows and their count", async () => {
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Acme")).toBeTruthy();
        expect(screen.getByText("Globex")).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Companies" })).toBeTruthy();
        expect(screen.getByRole("button", { name: /New company/ })).toBeTruthy();
    });

    it("keeps an edited cell once the server agrees", async () => {
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        await screen.findByText("Acme");
        fireEvent.click(cityCell("Acme"));
        const input = screen.getByDisplayValue("Madrid");
        fireEvent.change(input, { target: { value: "  Barcelona " } });
        await act(async () => {
            fireEvent.keyDown(input, { key: "Enter" });
        });
        expect(screen.getByText("Barcelona")).toBeTruthy();
        await waitFor(() => expect(state.updates).toHaveLength(1));
        expect(state.updates[0]).toMatchObject({ id: ACME, values: { city: "Barcelona" } });
        expect(screen.getByText("Barcelona")).toBeTruthy();
    });

    it("puts a cell back when the server refuses the change", async () => {
        state.refuseUpdate = true;
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        await screen.findByText("Acme");
        fireEvent.click(cityCell("Acme"));
        const input = screen.getByDisplayValue("Madrid");
        fireEvent.change(input, { target: { value: "Paris" } });
        await act(async () => {
            fireEvent.keyDown(input, { key: "Enter" });
        });
        await waitFor(() => expect(screen.queryByText("Paris")).toBeNull());
        expect(screen.getByText("Madrid")).toBeTruthy();
    });

    it("refuses an invalid value in the cell before anything is sent", async () => {
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        await screen.findByText("Acme");
        const row = screen.getByText("Acme").closest("tr")!;
        const employees = [...row.querySelectorAll("td")].find(
            (cell) => cell.getAttribute("aria-label") === "Employees"
        )!;
        fireEvent.click(employees);
        const input = row.querySelector("input[inputmode='numeric']") as HTMLInputElement;
        fireEvent.change(input, { target: { value: "lots" } });
        expect(screen.getByText("Enter a number.")).toBeTruthy();
        await act(async () => {
            fireEvent.keyDown(input, { key: "Enter" });
        });
        expect(state.updates).toHaveLength(0);
    });

    it("makes a record from the name typed into the top row", async () => {
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        await screen.findByText("Acme");
        fireEvent.click(screen.getByRole("button", { name: /New company/ }));
        const input = screen.getByRole("textbox", { name: "Name" });
        fireEvent.change(input, { target: { value: "Initech" } });
        await act(async () => {
            fireEvent.keyDown(input, { key: "Enter" });
        });
        await waitFor(() =>
            expect(state.creates).toEqual([{ object: "companies", values: { name: "Initech" } }])
        );
        expect(await screen.findByText("Initech")).toBeTruthy();
    });

    it("offers a reader who may not change records nothing that would", async () => {
        state.can = { read: true, edit: false, delete: false };
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        await screen.findByText("Acme");
        expect(screen.queryByRole("button", { name: /New company/ })).toBeNull();
        fireEvent.click(cityCell("Acme"));
        expect(screen.queryByDisplayValue("Madrid")).toBeNull();
    });

    it("draws a board view with a column per stage and moves a card from its menu", async () => {
        const deal = (id: string, name: string, stage: string, position: number): CrmRecord => ({
            id,
            position,
            deletedAt: null,
            values: { name, stage, amount: { amount: null, currency: "" } }
        });
        state.views = [
            {
                id: VIEW_ID,
                name: "",
                kind: "kanban",
                config: defaultConfig("opportunities")
            }
        ];
        state.groups = [
            { value: "new", records: [deal(ACME, "Acme deal", "new", 0)], total: 1 },
            { value: "screening", records: [], total: 0 },
            { value: "meeting", records: [deal(GLOBEX, "Globex deal", "meeting", 0)], total: 1 },
            { value: "proposal", records: [], total: 0 },
            { value: "customer", records: [], total: 0 }
        ];
        render(<ListScreen object="opportunities" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Acme deal")).toBeTruthy();
        for (const stage of ["New", "Screening", "Meeting", "Proposal", "Customer"]) {
            expect(screen.getByRole("region", { name: stage })).toBeTruthy();
        }
        const menu = screen.getByRole("button", { name: "Move Acme deal" });
        fireEvent.pointerDown(menu, { button: 0, ctrlKey: false });
        const proposal = await screen.findByRole("menuitem", { name: "Proposal" });
        await act(async () => {
            fireEvent.click(proposal);
        });
        await waitFor(() => expect(state.moves).toHaveLength(1));
        expect(state.moves[0]).toMatchObject({ id: ACME, key: "stage", value: "proposal" });
        const column = screen.getByRole("region", { name: "Proposal" });
        expect(column.textContent).toContain("Acme deal");
    });

    it("saves the list as it is drawn now as a new named view", async () => {
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        await screen.findByText("Acme");
        const picker = screen.getByRole("button", { name: "Choose a view" });
        fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
        await act(async () => {
            fireEvent.click(await screen.findByRole("menuitem", { name: "New view" }));
        });
        const name = await screen.findByRole("textbox", { name: /Name/ });
        fireEvent.change(name, { target: { value: "  Madrid  " } });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Create view" }));
        });
        await waitFor(() => expect(state.madeViews).toHaveLength(1));
        expect(state.madeViews[0]).toMatchObject({ name: "Madrid", kind: "table" });
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Choose a view" }).textContent).toContain(
                "Madrid"
            )
        );
    });

    it("reads the list again with a filter once its rule is whole", async () => {
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        await screen.findByText("Acme");
        fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
        fireEvent.click(await screen.findByRole("button", { name: /Add filter/ }));
        const before = state.lists.length;
        const value = await screen.findByRole("textbox", { name: "Value" });
        fireEvent.change(value, { target: { value: "Acm" } });
        await waitFor(() => expect(state.lists.length).toBeGreaterThan(before), { timeout: 2000 });
        expect(state.lists.at(-1)).toMatchObject({
            filter: { conjunction: "and", rules: [{ key: "name", operator: "contains", value: "Acm" }] }
        });
    });

    it("says so to somebody who may not see this kind of record", async () => {
        state.can = { read: false, edit: false, delete: false };
        render(<ListScreen object="companies" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Your role cannot see this list")).toBeTruthy();
    });
});
