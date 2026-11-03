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
vi.mock("@/app/(app)/router/actions", () => ({
    listMachinesAction,
    readRouterAction,
    applyRouterAction,
    removeRouterAction: vi.fn()
}));

const { RouterSection } = await import("@/app/(app)/router/router-view");

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

/** Add a line from its dialog, tagged when the port's plain traffic is taken. */
async function addLine(tagged = false): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    const form = await screen.findByRole("dialog");
    if (tagged) fireEvent.click(within(form).getByRole("radio", { name: "VLAN" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

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
        await addLine();
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
        await addLine();
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
        await addLine();
        expect(await screen.findByText("Add a network.")).toBeTruthy();
    });

    it("warns about what is running, and not about a line still in the draft", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        const ports = [{ ...PORT, name: "eth0", hasGateway: true }];
        const plan = { ...SAVED, wans: [{ interface: "eth0", vlan: null }] };
        readRouterAction.mockResolvedValue({
            plan,
            reading: { ...READING, running: true, ports }
        });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        const missing = "This port is not on the machine. Check that it is plugged in.";
        expect(await screen.findAllByText(missing)).toHaveLength(1);
        await addLine(true);
        await screen.findByRole("button", { name: "Discard" });
        expect(screen.getAllByText(missing)).toHaveLength(1);
        expect(screen.queryByText(/No internet from this port/)).toBeNull();
    });

    const WIFI_LAN = {
        ...SAVED.lans[0],
        interface: "wlan0",
        wifi: { ssid: "Fixture", country: "ES", band: "5" }
    };

    /** Save a network from its dialog unchanged, and send the draft with a moved line. */
    async function resaveNetwork(reading: unknown): Promise<{ wifi?: unknown }> {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        applyRouterAction.mockResolvedValue({});
        readRouterAction.mockResolvedValue({ plan: { ...SAVED, lans: [WIFI_LAN] }, reading });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        const form = await screen.findByRole("dialog");
        fireEvent.click(within(form).getByRole("button", { name: "Save" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0] as HTMLElement);
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
        const confirm = await screen.findByRole("dialog");
        fireEvent.click(within(confirm).getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(applyRouterAction).toHaveBeenCalledTimes(1));
        return applyRouterAction.mock.calls[0]?.[0].plan.lans[0];
    }

    it("keeps an access point whose radio is unplugged", async () => {
        const lan = await resaveNetwork(READING);
        expect(lan.wifi).toEqual(WIFI_LAN.wifi);
    });

    it("keeps an access point when the machine cannot be read", async () => {
        const lan = await resaveNetwork(null);
        expect(lan.wifi).toEqual(WIFI_LAN.wifi);
    });

    it("offers no access point on a port with no radio", async () => {
        const ports = [...READING.ports, { ...PORT, name: "wlan0", wireless: true }];
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({
            plan: { ...SAVED, lans: [{ ...WIFI_LAN, interface: "eth1" }] },
            reading: { ...READING, ports }
        });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        const form = await screen.findByRole("dialog");
        expect(within(form).queryByLabelText("Wi-Fi name *")).toBeNull();
    });

    it("judges what is running, not what the draft asks for", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        const ports = [
            { ...PORT, name: "eth0", hasGateway: true },
            { ...PORT, name: "eth1" }
        ];
        readRouterAction.mockResolvedValue({
            plan: { ...SAVED, wans: [{ interface: "eth0", vlan: null }] },
            reading: { ...READING, running: true, ports }
        });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
        const network = await screen.findByRole("dialog");
        fireEvent.click(within(network).getByRole("switch", { name: "IPv6" }));
        fireEvent.click(within(network).getByRole("button", { name: "Save" }));
        await screen.findByRole("button", { name: "Discard" });
        expect(screen.getByText("IPv6")).toBeTruthy();
        expect(screen.queryByText(/No IPv6 yet/)).toBeNull();
    });

    it("names the connection type on the line's form", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({ plan: SAVED, reading: READING });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        fireEvent.click(
            (await screen.findAllByRole("button", { name: "Edit line" }))[0] as HTMLElement
        );
        const form = await screen.findByRole("dialog");
        expect(within(form).getByText("Connection type")).toBeTruthy();
    });

    it("names a missing prefix client and lets Apply try again", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        const lans = SAVED.lans.map((lan) => ({ ...lan, ipv6: true }));
        readRouterAction.mockResolvedValue({
            plan: { ...SAVED, lans },
            reading: { ...READING, running: true, prefixClient: false }
        });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(/could not install dhcpcd/)).toBeTruthy();
        expect(screen.queryByText(/not offering a prefix/)).toBeNull();
        const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
        expect(apply.disabled).toBe(false);
    });

    it("blames the line only when the prefix client is there", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        const lans = SAVED.lans.map((lan) => ({ ...lan, ipv6: true }));
        readRouterAction.mockResolvedValue({
            plan: { ...SAVED, lans },
            reading: { ...READING, running: true, prefixClient: true }
        });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(/not offering a prefix/)).toBeTruthy();
        const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
        expect(apply.disabled).toBe(true);
    });

    it("names a stored fixed address that blocks the next change", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        const taken = { mac: "aa:bb:cc:dd:ee:01", address: "10.77.0.1" };
        const lans = SAVED.lans.map((lan) => ({ ...lan, reservations: [taken] }));
        readRouterAction.mockResolvedValue({ plan: { ...SAVED, lans }, reading: READING });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        const down = await screen.findAllByRole("button", { name: "Move down" });
        expect(screen.getByRole("button", { name: "Stop router" })).toBeTruthy();
        fireEvent.click(down[0] as HTMLElement);
        expect(await screen.findByText(/fixed address that cannot be used/)).toBeTruthy();
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

    /** The operator's machine: one port, the line and the network both untagged on it. */
    const ONE_PORT = {
        wans: [{ interface: "ens6", vlan: null }],
        lans: [{ ...SAVED.lans[0], name: "Test", interface: "ens6" }],
        forwards: []
    };
    const VPS = {
        ...READING,
        ports: [{ ...PORT, name: "ens6", addresses: ["192.0.2.10/32"], hasGateway: true }]
    };

    it("names a port clash and ends it with one button", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({ plan: null, reading: VPS });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("This machine has one port, ens6")).toBeTruthy();
        await addLine();
        fireEvent.click(screen.getByRole("button", { name: "Add network" }));
        const form = await screen.findByRole("dialog");
        const tag = within(form).getByRole("radio", { name: "VLAN" });
        expect(tag.getAttribute("aria-checked")).toBe("true");
        expect(
            (within(form).getByRole("textbox", { name: "VLAN tagging" }) as HTMLInputElement).value
        ).toBe("10");
        fireEvent.click(within(form).getByRole("radio", { name: "Untagged" }));
        expect(
            within(form).getByText(
                "ens6 untagged is already used by internet line 1. Choose VLAN, or another port."
            )
        ).toBeTruthy();
        fireEvent.change(within(form).getByLabelText("Name *"), { target: { value: "Test" } });
        fireEvent.click(within(form).getByRole("button", { name: "Save" }));
        expect(screen.getByRole("dialog")).toBeTruthy();
        fireEvent.click(within(form).getByRole("radio", { name: "VLAN" }));
        fireEvent.click(within(form).getByRole("button", { name: "Save" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(screen.getAllByText("VLAN 10").length).toBeGreaterThan(0);
    });

    it("moves a clashing network onto a free VLAN and lets it apply", async () => {
        listMachinesAction.mockResolvedValue({ machines: [MACHINE], privateNetworks: [] });
        readRouterAction.mockResolvedValue({ plan: ONE_PORT, reading: VPS });
        render(<RouterSection />, { wrapper: MessagesWrapper });
        expect(
            await screen.findByText(
                "ens6 untagged is used by both internet line 1 and the Test network."
            )
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Move Test to VLAN 10" }));
        await screen.findByRole("button", { name: "Discard" });
        expect(screen.queryByText(/is used by both/)).toBeNull();
        const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
        expect(apply.disabled).toBe(false);
        fireEvent.click(apply);
        const confirm = await screen.findByRole("dialog");
        fireEvent.click(within(confirm).getByRole("button", { name: "Apply" }));
        await waitFor(() => expect(applyRouterAction).toHaveBeenCalledTimes(1));
        expect(applyRouterAction.mock.calls[0]?.[0].plan.lans[0].vlan).toBe(10);
    });
});
