// @vitest-environment jsdom

/**
 * The dashboards screen: an empty shelf offers to make one, a chart shows its
 * figure and the same numbers as a table, a new chart is kept, and a reader
 * who may change nothing is offered nothing that would.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Widget, WidgetData } from "@polaris-app/crm/src/model/dashboards";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const BOARD = "77777777-7777-4777-8777-777777777777";

const state = vi.hoisted(() => ({
    dashboards: [] as { id: string; name: string; widgets: Widget[] }[],
    manage: true,
    data: { kind: "number", value: 12 } as WidgetData,
    saved: [] as unknown[],
    created: [] as unknown[]
}));

vi.mock("@polaris-app/crm/src/actions/dashboards", () => {
    const can = { read: true, edit: true, delete: true };
    return {
        openDashboardsAction: async () => ({
            ok: true,
            dashboards: state.dashboards,
            can: { companies: can, people: can, opportunities: can },
            canManage: state.manage,
            objects: {
                companies: { views: [], fields: [] },
                people: { views: [], fields: [] },
                opportunities: { views: [], fields: [] }
            }
        }),
        createDashboardAction: async (input: { name: string }) => {
            state.created.push(input);
            return { ok: true, dashboard: { id: BOARD, name: input.name, widgets: [] } };
        },
        saveWidgetsAction: async (input: { id: string; widgets: Widget[] }) => {
            state.saved.push(input);
            return { ok: true, dashboard: { id: input.id, name: "Sales", widgets: input.widgets } };
        },
        widgetDataAction: async () => ({ ok: true, data: state.data }),
        renameDashboardAction: vi.fn(),
        deleteDashboardAction: vi.fn()
    };
});

import { DashboardsScreen } from "@polaris-app/crm/src/screens/dashboards-screen";

const stageWidget: Widget = {
    id: "0193b0f0-0000-7000-8000-000000000001",
    title: "",
    object: "opportunities",
    chart: "bar",
    measure: "count",
    field: null,
    currency: null,
    groupBy: "stage",
    granularity: null,
    viewId: null,
    wide: false
};

beforeEach(() => {
    state.dashboards = [];
    state.manage = true;
    state.data = { kind: "number", value: 12 };
    state.saved = [];
    state.created = [];
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
    if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(cleanup);

describe("dashboards", () => {
    it("offers to make the first one, and opens it", async () => {
        render(<DashboardsScreen />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: "New dashboard" }));
        fireEvent.change(screen.getByPlaceholderText("Sales this quarter"), {
            target: { value: "  Sales   pipeline " }
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
        });
        await waitFor(() => expect(state.created).toEqual([{ name: "Sales pipeline" }]));
        expect(await screen.findByText("No charts yet")).toBeTruthy();
    });

    it("draws a split chart, names it after what it counts, and shows it as a table", async () => {
        state.dashboards = [{ id: BOARD, name: "Sales", widgets: [stageWidget] }];
        state.data = {
            kind: "groups",
            points: [
                { key: "new", label: null, value: 2 },
                { key: "meeting", label: null, value: 4 }
            ],
            other: null,
            capped: false
        };
        render(<DashboardsScreen />, { wrapper: MessagesWrapper });
        expect(
            await screen.findByRole("region", { name: "Number of Opportunities by Stage" })
        ).toBeTruthy();
        expect(await screen.findByText("Meeting")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Show as a table" }));
        const table = screen.getByRole("table");
        expect(table.textContent).toContain("New");
        expect(table.textContent).toContain("4");
    });

    it("keeps a new chart with what the dialog holds", async () => {
        state.dashboards = [{ id: BOARD, name: "Sales", widgets: [] }];
        render(<DashboardsScreen />, { wrapper: MessagesWrapper });
        const add = await screen.findAllByRole("button", { name: "Add a chart" });
        fireEvent.click(add[0]!);
        fireEvent.change(screen.getByPlaceholderText("Named after what it counts"), {
            target: { value: "Open deals" }
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
        });
        await waitFor(() => expect(state.saved).toHaveLength(1));
        const [saved] = state.saved as { id: string; widgets: Widget[] }[];
        expect(saved!.id).toBe(BOARD);
        expect(saved!.widgets).toEqual([
            expect.objectContaining({ title: "Open deals", chart: "number", measure: "count" })
        ]);
        expect(await screen.findByText("12")).toBeTruthy();
    });

    it("offers a reader who may change nothing no way to", async () => {
        state.manage = false;
        state.dashboards = [{ id: BOARD, name: "Sales", widgets: [stageWidget] }];
        render(<DashboardsScreen />, { wrapper: MessagesWrapper });
        await screen.findByRole("region", { name: "Number of Opportunities by Stage" });
        expect(screen.queryByRole("button", { name: "Add a chart" })).toBeNull();
        expect(screen.queryByRole("button", { name: /Options for/ })).toBeNull();
    });
});
