// @vitest-environment jsdom

/**
 * An address field that takes a MAC, and the units found on the network.
 *
 * Drawn with the server actions replaced. What is checked is the dialog: the
 * units a scan found are offered with their names, MACs and addresses before
 * anything is typed; picking one fills the address with its MAC; the MAC box
 * keeps itself formatted and a half-typed MAC holds Connect back; and a MAC
 * pasted into the IP box is taken as the MAC it is.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const connected: { connection: string; label: string; fields: Record<string, string> }[] = [];
const scans: unknown[] = [];

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    discoverDeviceUnitsAction: async (input: unknown) => {
        scans.push(input);
        return {
            units: [
                {
                    name: "Bedroom",
                    model: "gree",
                    mac: "AA:BB:CC:11:22:33",
                    address: "10.0.1.40"
                },
                { name: "Lounge", model: "gree", mac: "AA:BB:CC:44:55:66", address: "10.0.1.41" }
            ]
        };
    },
    connectDeviceAccountAction: async (input: {
        connection: string;
        label: string;
        fields: Record<string, string>;
    }) => {
        connected.push(input);
        return { devices: [], accounts: [] };
    },
    reconnectDeviceAccountAction: async () => ({}),
    startDevicePairingAction: async () => ({}),
    pollDevicePairingAction: async () => ({})
}));

const { ConnectDialog } = await import("@polaris-app/places/src/screens/devices/connect-dialog");

afterEach(() => {
    cleanup();
    connected.length = 0;
    scans.length = 0;
});

function drawn(make: string, search: string) {
    render(
        withMessages(
            <ConnectDialog open reconnect={null} onClose={() => {}} onConnected={() => {}} />
        )
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: search } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${make}`) }));
}

const connect = () => screen.getByRole("button", { name: "Connect" });

describe("units found on the network", () => {
    it("are offered with their name, MAC and address before anything is typed", async () => {
        drawn("Gree", "gree");
        expect(await screen.findByText("Found on your network")).toBeTruthy();
        expect(await screen.findByRole("button", { name: "Use Bedroom" })).toBeTruthy();
        expect(screen.getByText("AA:BB:CC:44:55:66 - 10.0.1.41")).toBeTruthy();
        expect(scans).toEqual([{ connection: "gree-local", fresh: false }]);
    });

    it("fill the address with the MAC of the one picked, and its name", async () => {
        drawn("Gree", "gree");
        fireEvent.click(await screen.findByRole("button", { name: "Use Lounge" }));
        const address = screen.getByRole("textbox", { name: "Unit address" }) as HTMLInputElement;
        expect(address.value).toBe("AA:BB:CC:44:55:66");
        expect(screen.getByRole("radio", { name: "MAC" }).getAttribute("aria-checked")).toBe(
            "true"
        );
        fireEvent.click(connect());
        await waitFor(() => expect(connected).toHaveLength(1));
        expect(connected[0]).toMatchObject({
            connection: "gree-local",
            label: "Lounge",
            fields: { host: "AA:BB:CC:44:55:66" }
        });
    });

    it("are kept for a moment, and asked for again, fresh, from Search again", async () => {
        drawn("Gree", "gree");
        await screen.findByRole("button", { name: "Use Bedroom" });
        // Drawn again within half a minute: what the last scan found, no scan.
        const before = scans.length;
        expect(before).toBeLessThanOrEqual(1);
        fireEvent.click(screen.getByRole("button", { name: "Search again" }));
        await waitFor(() => expect(scans).toHaveLength(before + 1));
        expect(scans.at(-1)).toEqual({ connection: "gree-local", fresh: true });
    });
});

describe("an address given as a MAC", () => {
    it("is formatted as it is typed, and Connect waits for all twelve digits", async () => {
        drawn("Shelly", "shelly");
        fireEvent.click(screen.getByRole("radio", { name: "MAC" }));
        const box = screen.getByRole("textbox", { name: "Device address" }) as HTMLInputElement;
        fireEvent.change(box, { target: { value: "c8f742", selectionStart: 6 } });
        expect(box.value).toBe("C8:F7:42");
        expect(connect().getAttribute("aria-disabled")).toBe("true");
        // Not called short while it is still being typed.
        expect(screen.queryByText("A MAC address has 12 digits.")).toBeNull();
        fireEvent.change(box, { target: { value: "C8:F7:421a2b3c" } });
        expect(box.value).toBe("C8:F7:42:1A:2B:3C");
        expect(connect().getAttribute("aria-disabled")).toBe("false");
    });

    it("says a half-typed MAC is short once the box is left", () => {
        drawn("Shelly", "shelly");
        fireEvent.click(screen.getByRole("radio", { name: "MAC" }));
        const box = screen.getByRole("textbox", { name: "Device address" });
        fireEvent.focus(box);
        fireEvent.change(box, { target: { value: "c8f7" } });
        fireEvent.blur(box);
        expect(screen.getByText("A MAC address has 12 digits.")).toBeTruthy();
    });

    it("is recognised when pasted into the IP box", () => {
        drawn("Shelly", "shelly");
        const box = screen.getByRole("textbox", { name: "Device address" }) as HTMLInputElement;
        fireEvent.paste(box, { clipboardData: { getData: () => "c8-f7-42-1a-2b-3c" } });
        expect(box.value).toBe("C8:F7:42:1A:2B:3C");
        expect(screen.getByRole("radio", { name: "MAC" }).getAttribute("aria-checked")).toBe(
            "true"
        );
    });

    it("removes the digit before a colon on Backspace", () => {
        drawn("Shelly", "shelly");
        fireEvent.click(screen.getByRole("radio", { name: "MAC" }));
        const box = screen.getByRole("textbox", { name: "Device address" }) as HTMLInputElement;
        fireEvent.change(box, { target: { value: "c8f742" } });
        box.setSelectionRange(3, 3);
        fireEvent.keyDown(box, { key: "Backspace" });
        expect(box.value).toBe("CF:74:2");
        expect(box.selectionStart).toBe(1);
    });
});
