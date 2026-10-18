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
    scopes: [] as unknown[],
    refuseToggle: false
}));

vi.mock("@polaris-app/places/src/screens/automations/actions", () => ({
    listAutomationsAction: async (scope?: unknown) => {
        state.scopes.push(scope);
        return { ok: true, automations: state.rows, devices: [] };
    },
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

import {
    AutomationsView,
    NewAutomationMenu,
    UnmovedAutomations
} from "@polaris-app/places/src/screens/automations/automations-view";

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
    state.scopes = [];
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

    it("lists only what has not moved, of the place it is about", async () => {
        state.rows = [
            { ...(state.rows[0] as object), movedTo: "00000000-0000-4000-8000-000000000007" },
            {
                ...(state.rows[0] as object),
                id: "88888888-8888-4888-8888-888888888888",
                name: "Still here"
            }
        ];
        open();
        expect(await screen.findByText("Still here")).toBeTruthy();
        expect(state.scopes).toEqual([{ placeId: "place-1" }]);
        expect(screen.getByText("Not moved yet")).toBeTruthy();
        expect(screen.queryByText("Porch light at dusk")).toBeNull();
    });

    it("draws no leftover section once everything moved", async () => {
        state.rows = [
            { ...(state.rows[0] as object), movedTo: "00000000-0000-4000-8000-000000000007" }
        ];
        open();
        await waitFor(() => expect(state.scopes).toHaveLength(1));
        await waitFor(() => expect(screen.queryByText("Not moved yet")).toBeNull());
    });

    it("asks for every place when the central list is narrowed to Places only", async () => {
        render(<UnmovedAutomations placeId={null} canManage />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Porch light at dusk")).toBeTruthy();
        expect(state.scopes).toEqual(["all"]);
    });

    it("starts a new one, blank or from a template, at the place the list is about", async () => {
        render(<NewAutomationMenu placeId="place-1" />, { wrapper: MessagesWrapper });
        fireEvent.keyDown(screen.getByRole("button", { name: "New automation" }), { key: "Enter" });
        const links = (await screen.findAllByRole("menuitem")).map((item) =>
            item.getAttribute("href")
        );
        expect(links[0]).toBe("/places/devices/automations/new?place=place-1");
        expect(links.length).toBeGreaterThan(1);
        for (const href of links.slice(1)) expect(href).toMatch(/\?template=\w+&place=place-1$/);
    });
});
