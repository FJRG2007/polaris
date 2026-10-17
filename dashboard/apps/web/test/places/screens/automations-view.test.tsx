// @vitest-environment jsdom

/**
 * Places' automation list, rebuilt on the shared rule pieces (`RuleList`,
 * `RuleRow`, `RuleAction`) that Places automations now shares with the CRM's
 * workflows dialog - switched on or off where it stands, run by hand, and
 * opened to its log, the same way every rule builder draws a rule.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const FLOW = "99999999-9999-4999-8999-999999999999";

const state = vi.hoisted(() => ({
    rows: [] as unknown[],
    toggled: [] as unknown[],
    ran: [] as unknown[],
    refuseToggle: false
}));

vi.mock("@polaris-app/places/src/screens/automations/actions", () => ({
    listAutomationsAction: async () => ({ ok: true, automations: state.rows, devices: [] }),
    setAutomationEnabledAction: async (id: string, enabled: boolean) => {
        state.toggled.push({ id, enabled });
        return state.refuseToggle
            ? { error: "You may not manage automations here." }
            : { automation: { ...(state.rows[0] as object), enabled } };
    },
    runAutomationAction: async (id: string) => {
        state.ran.push(id);
        return {};
    },
    deleteAutomationAction: vi.fn()
}));

// The central list is the dashboard's own screen, tested there; here only what it is handed.
vi.mock("@/app/(app)/automations/embedded-list", () => ({
    EmbeddedAutomationsList: ({ from }: { from?: { origin: string; originRef?: string | null } }) => (
        <div data-testid="central-list">{`${from?.origin}:${from?.originRef}`}</div>
    )
}));

import { AutomationsView } from "@polaris-app/places/src/screens/automations/automations-view";

const blankDefinition = {
    timeZone: "UTC",
    triggers: [],
    conditions: { match: "all" as const, groups: [] },
    actions: []
};

const open = (canManage = true) =>
    render(<AutomationsView placeId="place-1" canManage={canManage} />, {
        wrapper: MessagesWrapper
    });

beforeEach(() => {
    state.rows = [
        {
            id: FLOW,
            placeId: "place-1",
            name: "Porch light at dusk",
            enabled: true,
            ownerName: "Test User",
            definition: blankDefinition,
            lastRunAt: null,
            lastStatus: null,
            updatedAt: "2026-10-01T10:00:00.000Z"
        }
    ];
    state.toggled = [];
    state.ran = [];
    state.refuseToggle = false;
});

afterEach(cleanup);

describe("the places automation list, on the shared rule pieces", () => {
    it("lists an automation as a rule row, switch and all", async () => {
        open();
        expect(await screen.findByText("Porch light at dusk")).toBeTruthy();
        expect(screen.getByRole("switch", { name: "Switch off Porch light at dusk" })).toBeTruthy();
        expect(screen.getByRole("link", { name: "Porch light at dusk" })).toHaveProperty(
            "href",
            expect.stringContaining(
                "/places/devices/automations/99999999-9999-4999-8999-999999999999"
            )
        );
    });

    it("switches one off at once, and back on when the server refuses", async () => {
        state.refuseToggle = true;
        open();
        const toggle = await screen.findByRole("switch", {
            name: "Switch off Porch light at dusk"
        });
        await act(async () => {
            fireEvent.click(toggle);
        });
        await waitFor(() => expect(state.toggled).toEqual([{ id: FLOW, enabled: false }]));
        await waitFor(() =>
            expect(
                screen
                    .getByRole("switch", { name: "Switch off Porch light at dusk" })
                    .getAttribute("aria-checked")
            ).toBe("true")
        );
        expect((await screen.findByRole("alert")).textContent).toBe(
            "You may not manage automations here."
        );
    });

    it("runs one by hand and says it started", async () => {
        open();
        await screen.findByText("Porch light at dusk");
        fireEvent.click(screen.getByRole("button", { name: "Run Porch light at dusk now" }));
        await waitFor(() => expect(state.ran).toEqual([FLOW]));
        expect((await screen.findByRole("status")).textContent).toBe("Started");
    });

    it("hides every management action from somebody who may only view", async () => {
        open(false);
        await screen.findByText("Porch light at dusk");
        expect(
            screen.getByRole("switch", { name: "Switch off Porch light at dusk" })
        ).toHaveProperty("disabled", true);
        expect(screen.queryByRole("button", { name: /Run .* now/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
        expect(screen.getByRole("link", { name: "What Porch light at dusk did" })).toBeTruthy();
    });

    it("shows the central list of this place's automations, and a moved row only there", async () => {
        state.rows = [
            { ...(state.rows[0] as object), movedTo: "00000000-0000-4000-8000-000000000007" },
            {
                ...(state.rows[0] as object),
                id: "88888888-8888-4888-8888-888888888888",
                name: "Still here"
            }
        ];
        open();
        expect((await screen.findByTestId("central-list")).textContent).toBe("home:place-1");
        expect(await screen.findByText("Still here")).toBeTruthy();
        expect(screen.getByText("Not moved yet")).toBeTruthy();
        expect(screen.queryByText("Porch light at dusk")).toBeNull();
    });

    it("draws no leftover section once everything moved", async () => {
        state.rows = [{ ...(state.rows[0] as object), movedTo: "00000000-0000-4000-8000-000000000007" }];
        open();
        await screen.findByTestId("central-list");
        await waitFor(() => expect(screen.queryByText("Not moved yet")).toBeNull());
    });
});
