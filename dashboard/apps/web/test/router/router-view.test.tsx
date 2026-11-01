// @vitest-environment jsdom

/**
 * The Router screen: a machine without root is not offered, nothing is sent until
 * Apply, and a line added to the draft is what goes to the machine.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

const MACHINE = {
    id: "0190f1c2-0000-7000-8000-00000000000a",
    name: "fixture-pi",
    address: "192.0.2.5",
    root: true
};
const PORT = { up: true, mac: null, addresses: [], hasGateway: false, received: 0, sent: 0 };
const READING = {
    ports: [
        { ...PORT, name: "eth0" },
        { ...PORT, name: "eth1" }
    ],
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

    const SAVED = {
        wans: [
            { interface: "eth0", vlan: null },
            { interface: "eth2", vlan: null }
        ],
        lans: [
            {
                id: "0190f1c2-0000-7000-8000-000000000001",
                name: "Home",
                interface: "eth1",
                vlan: null,
                cidr: "10.77.0.0/24",
                address: "10.77.0.1",
                internet: true,
                isolated: false,
                reservations: []
            }
        ],
        forwards: []
    };

    /** Open a machine with a saved plan, move its first line down and press Apply. */
    async function applyMovedLine(): Promise<HTMLElement> {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({ plan: SAVED, reading: READING });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        const down = await screen.findAllByRole("button", { name: "Move down" });
        fireEvent.click(down[0] as HTMLElement);
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
        return dialog;
    }

    it("sends the changed plan on Apply and drops the draft once it held", async () => {
        applyRouterAction.mockResolvedValue({});
        await applyMovedLine();
        await waitFor(() => expect(applyRouterAction).toHaveBeenCalledTimes(1));
        const sent = applyRouterAction.mock.calls[0]?.[0];
        expect(sent.hostId).toBe(MACHINE.id);
        expect(sent.plan.wans.map((wan: { interface: string }) => wan.interface)).toEqual([
            "eth2",
            "eth0"
        ]);
        await waitFor(() => expect(screen.queryByRole("button", { name: "Discard" })).toBeNull());
    });

    it("keeps the draft and says why when a change did not hold", async () => {
        applyRouterAction.mockResolvedValue({ error: "It went back" });
        const dialog = await applyMovedLine();
        expect(await within(dialog).findByText("It went back")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Discard", hidden: true })).toBeTruthy();
    });

    it("says what is missing when Apply stays off", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({ plan: null, reading: READING });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        await screen.findByText("eth1");
        expect(screen.queryByText("Add a network.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Add line" }));
        expect(await screen.findByText("Add a network.")).toBeTruthy();
    });

    it("does not offer a port a plan cannot hold", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        const ports = [
            { ...PORT, name: "eth0.20" },
            { ...PORT, name: "eth1" }
        ];
        readRouterAction.mockResolvedValue({ plan: null, reading: { ...READING, ports } });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        await screen.findByText("eth0.20");
        fireEvent.click(screen.getByRole("button", { name: "Add line" }));
        expect(await screen.findByText("Add a network.")).toBeTruthy();
    });

    it("stops the skeletons when the machine does not answer", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({ plan: null, reading: null });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Not answering")).toBeTruthy();
        expect(screen.getAllByText("Polaris cannot read this machine right now.")).toHaveLength(2);
    });

    it("draws a bounded list of devices and searches the rest", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        const clients = Array.from({ length: 300 }, (_, at) => ({
            address: `10.77.${Math.floor(at / 250)}.${(at % 250) + 2}`,
            mac: "aa:bb:cc:00:00:01",
            name: `device-${at}`,
            expires: 0
        }));
        readRouterAction.mockResolvedValue({ plan: null, reading: { ...READING, clients } });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("device-199")).toBeTruthy();
        expect(screen.queryByText("device-200")).toBeNull();
        expect(screen.getByText("Showing 200 of 300. Search to narrow them down.")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Search devices"), {
            target: { value: "device-299" }
        });
        expect(await screen.findByText("device-299")).toBeTruthy();
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
