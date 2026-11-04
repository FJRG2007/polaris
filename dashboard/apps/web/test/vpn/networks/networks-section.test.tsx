// @vitest-environment jsdom

/**
 * The Private networks screen: a member sees no management and no secret, an
 * administrator sees where a network stands, and the form refuses a subnet as it
 * is typed and sends a clean one.
 */

import type { ReactElement } from "react";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkView } from "@/lib/vpn/network-service";
import {
    cleanup,
    fireEvent,
    render as draw,
    screen,
    waitFor,
    within
} from "@testing-library/react";

const listNetworksAction = vi.fn();
const createNetworkAction = vi.fn();
const removeNetworkAction = vi.fn();
vi.mock("@/app/(app)/deploy-target-options-actions", () => ({
    listDeployTargetOptionsAction: async () => ({ items: [], next: null })
}));
vi.mock("@/app/(app)/vpn/networks/actions", () => ({
    listNetworksAction,
    createNetworkAction,
    updateNetworkAction: vi.fn(),
    retryGatewayAction: vi.fn(),
    removeNetworkAction
}));

const { VpnNetworksSection } = await import("@/app/(app)/vpn/networks/networks");

const render = (ui: ReactElement) => draw(ui, { wrapper: MessagesWrapper });

const NETWORK: NetworkView = {
    id: "0190f1c2-0000-7000-8000-000000000001",
    name: "Fixture home",
    cidr: "10.77.0.0/24",
    routerAddress: "10.77.0.1",
    access: "admins",
    internet: false,
    serverName: "fixture-server",
    gateway: "online",
    routerReachable: false,
    setup: {
        ssid: "Fixture wifi",
        wifiPassword: "fixture-password",
        dhcp: { first: "10.77.0.100", last: "10.77.0.249" },
        bridge: "br-pn0190f1",
        openWrt: "#!/bin/sh\n"
    }
};

afterEach(() => {
    cleanup();
    listNetworksAction.mockReset();
    createNetworkAction.mockReset();
    removeNetworkAction.mockReset();
});

describe("VpnNetworksSection", () => {
    // First: a read is remembered for the tab, so only this one starts with no answer.
    it("offers no new network before it knows the servers", async () => {
        listNetworksAction.mockReturnValue(new Promise(() => undefined));
        render(<VpnNetworksSection isAdmin />);
        const button = screen.getByRole("button", { name: "New network" }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });

    it("shows an administrator the state, the router and its values", async () => {
        listNetworksAction.mockResolvedValue({ networks: [NETWORK], firstServer: null });
        render(<VpnNetworksSection isAdmin />);
        expect(await screen.findByText("Fixture home")).toBeTruthy();
        expect(screen.getByText("Connected")).toBeTruthy();
        expect(screen.getByText("Router not answering")).toBeTruthy();
        expect(screen.getByText("fixture-password")).toBeTruthy();
    });

    it("gives a member the network and nothing to manage", async () => {
        const shared = { ...NETWORK, access: "everyone" as const, setup: null };
        listNetworksAction.mockResolvedValue({
            networks: [shared],
            firstServer: null
        });
        render(<VpnNetworksSection isAdmin={false} />);
        expect(await screen.findByText("Fixture home")).toBeTruthy();
        expect(screen.queryByText("New network")).toBeNull();
        expect(screen.queryByText("Router setup")).toBeNull();
    });

    it("refuses a subnet another network uses before anything is sent", async () => {
        listNetworksAction.mockResolvedValue({
            networks: [NETWORK],
            firstServer: { id: "target-1", name: "fixture-server" }
        });
        render(<VpnNetworksSection isAdmin />);
        fireEvent.click((await screen.findAllByText("New network"))[0] as HTMLElement);
        const subnet = await screen.findByLabelText("Subnet *");
        fireEvent.change(subnet, { target: { value: "10.77.0.128/25" } });
        expect(await screen.findByText("Another network already uses this subnet.")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Home" } });
        fireEvent.click(screen.getByRole("button", { name: "Create network" }));
        expect(createNetworkAction).not.toHaveBeenCalled();
    });

    it("says what is wrong with a subnet as it is typed, and sends what is typed", async () => {
        listNetworksAction.mockResolvedValue({
            networks: [],
            firstServer: { id: "target-1", name: "fixture-server" }
        });
        createNetworkAction.mockResolvedValue({});
        render(<VpnNetworksSection isAdmin />);
        await screen.findByText("No private networks");
        fireEvent.click(screen.getAllByText("New network")[0] as HTMLElement);
        const subnet = (await screen.findByLabelText("Subnet *")) as HTMLInputElement;
        expect(subnet.value).toBe("10.77.0.0/24");

        fireEvent.change(subnet, { target: { value: "172.17.0.0/24" } });
        expect(
            await screen.findByText("Use a 10.x.x.x or 192.168.x.x subnet between /16 and /29.")
        ).toBeTruthy();

        fireEvent.change(subnet, { target: { value: "10.77.3.0/24" } });
        expect((screen.getByLabelText("Router address *") as HTMLInputElement).value).toBe(
            "10.77.3.1"
        );
        fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Home" } });
        expect((screen.getByLabelText("Wi-Fi name *") as HTMLInputElement).value).toBe("Home");

        fireEvent.click(screen.getByRole("button", { name: "Create network" }));
        await waitFor(() => expect(createNetworkAction).toHaveBeenCalledTimes(1));
        expect(createNetworkAction.mock.calls[0]?.[0]).toMatchObject({
            name: "Home",
            cidr: "10.77.3.0/24",
            routerAddress: "10.77.3.1",
            targetId: "target-1",
            ssid: "Home",
            access: "admins",
            internet: false
        });
    });

    it("says what the limited edition lacks instead of offering a network", async () => {
        listNetworksAction.mockResolvedValue({ networks: [], firstServer: null, limited: true });
        render(<VpnNetworksSection isAdmin />);
        expect(await screen.findByText(/need the full edition/)).toBeTruthy();
        expect(screen.queryByText("New network")).toBeNull();
    });

    it("gives every subnet size its DHCP range", async () => {
        const setup = { ...NETWORK.setup, dhcp: { first: "10.77.2.100", last: "10.77.2.249" } };
        listNetworksAction.mockResolvedValue({
            networks: [{ ...NETWORK, cidr: "10.77.2.0/23", setup }],
            firstServer: null
        });
        render(<VpnNetworksSection isAdmin />);
        expect(await screen.findByText("10.77.2.100 - 10.77.2.249")).toBeTruthy();
    });

    it("closes the dialog on a network that was saved, and keeps the notice", async () => {
        listNetworksAction.mockResolvedValue({
            networks: [],
            firstServer: { id: "target-1", name: "fixture-server" }
        });
        createNetworkAction.mockResolvedValue({ notice: "Fixture notice" });
        render(<VpnNetworksSection isAdmin />);
        await screen.findByText("No private networks");
        fireEvent.click(screen.getAllByText("New network")[0] as HTMLElement);
        fireEvent.change(await screen.findByLabelText("Name *"), { target: { value: "Home" } });
        fireEvent.click(screen.getByRole("button", { name: "Create network" }));
        expect(await screen.findByText("Fixture notice")).toBeTruthy();
        await waitFor(() => expect(screen.queryByLabelText("Name *")).toBeNull());
    });

    it("forgets a failed create on cancel and reopens clean from the empty state", async () => {
        listNetworksAction.mockResolvedValue({
            networks: [],
            firstServer: { id: "target-1", name: "fixture-server" }
        });
        createNetworkAction.mockResolvedValue({ error: "Fixture failure" });
        render(<VpnNetworksSection isAdmin />);
        await screen.findByText("No private networks");
        fireEvent.click(screen.getAllByText("New network")[1] as HTMLElement);
        fireEvent.change(await screen.findByLabelText("Name *"), { target: { value: "Home" } });
        fireEvent.click(screen.getByRole("button", { name: "Create network" }));
        expect((await screen.findAllByText("Fixture failure")).length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByLabelText("Name *")).toBeNull());
        expect(screen.queryByText("Fixture failure")).toBeNull();

        fireEvent.click(screen.getAllByText("New network")[1] as HTMLElement);
        await screen.findByLabelText("Name *");
        expect(screen.queryByText("Fixture failure")).toBeNull();
    });

    it("forgets a failed removal on cancel", async () => {
        listNetworksAction.mockResolvedValue({ networks: [NETWORK], firstServer: null });
        removeNetworkAction.mockResolvedValue({ error: "Fixture failure" });
        render(<VpnNetworksSection isAdmin />);
        await screen.findByText("Fixture home");
        fireEvent.click(screen.getByRole("button", { name: "Remove network" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByRole("textbox"), {
            target: { value: "Fixture home" }
        });
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove network" }));
        expect((await screen.findAllByText("Fixture failure")).length).toBeGreaterThan(0);

        const cancel = within(dialog).getByRole("button", { name: "Cancel" });
        await waitFor(() => expect((cancel as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(cancel);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(screen.queryByText("Fixture failure")).toBeNull();
    });
});
