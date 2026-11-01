// @vitest-environment jsdom

/**
 * The Router screen: a machine without root is not offered, nothing is sent until
 * Apply, and a line added to the draft is what goes to the machine.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listMachinesAction = vi.fn();
const readRouterAction = vi.fn();
const applyRouterAction = vi.fn();
vi.mock("@/app/(app)/apps/router/actions", () => ({
    listMachinesAction,
    readRouterAction,
    applyRouterAction,
    removeRouterAction: vi.fn()
}));

const { RouterSection } = await import("@/app/(app)/apps/router/router-view");

const MACHINE = { id: "0190f1c2-0000-7000-8000-00000000000a", name: "fixture-pi", address: "192.0.2.5", root: true };
const PORT = { up: true, mac: null, addresses: [], hasGateway: false, received: 0, sent: 0 };
const READING = {
    ports: [{ ...PORT, name: "eth0" }, { ...PORT, name: "eth1" }],
    activeWan: null,
    running: false,
    clients: [],
    rolledBack: false
};

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("RouterSection", () => {
    it("says what to do when there is no machine", async () => {
        listMachinesAction.mockResolvedValue({ machines: [], privateNetworks: [] });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("No machines yet")).toBeTruthy();
    });

    it("shows the ports and does not offer Apply until something changed", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({ plan: null, reading: READING });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("eth1")).toBeTruthy();
        expect(screen.getByText("Not a router yet")).toBeTruthy();
        const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
        expect(apply.disabled).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Add line" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy());
        expect(applyRouterAction).not.toHaveBeenCalled();
    });

    it("says the machine went back after a change that did not hold", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({
            plan: null,
            reading: { ...READING, rolledBack: true }
        });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("The last change did not hold and was undone")).toBeTruthy();
    });
});
