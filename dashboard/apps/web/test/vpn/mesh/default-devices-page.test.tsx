// @vitest-environment jsdom

/**
 * The VPN's Devices screen by default: the devices that connect from Polaris's
 * own apps, a way to get those apps, and no third-party client named anywhere -
 * in either language. The device mesh's list is there only while it is on.
 */

import { withMessages } from "../../setup/i18n";
import enVpn from "../../../messages/en-US/vpn.json";
import esVpn from "../../../messages/es-ES/vpn.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ mesh: false }));
const vpnAppDevicesAction = vi.fn();
const listVpnDevicesAction = vi.fn();

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "fixture-user", isAdmin: true })
}));
vi.mock("@/lib/vpn/mesh", () => ({ vpnMeshOn: async () => state.mesh }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/vpn/connect-actions", () => ({
    vpnAppDevicesAction,
    removeVpnDeviceAction: vi.fn()
}));
vi.mock("@/app/(app)/vpn/actions", () => ({
    listVpnDevicesAction,
    renameVpnDeviceAction: vi.fn(),
    removeVpnDeviceAction: vi.fn(),
    setVpnDeviceRoutesAction: vi.fn()
}));

const { default: VpnDevicesPage } = await import("@/app/(app)/vpn/devices/page");

const DEVICE = {
    id: "0190f1c2-0000-7000-8000-000000000001",
    name: "fixture-laptop",
    lastHandshake: null,
    received: "0",
    sent: "0",
    node: { name: "Fixture node", exit: "direct" },
    user: { id: "fixture-user", name: "Fixture Person", email: "fixture@example.test" }
};

afterEach(() => {
    cleanup();
    vpnAppDevicesAction.mockReset();
    listVpnDevicesAction.mockReset();
    state.mesh = false;
});

async function draw(locale: "en-US" | "es-ES" = "en-US") {
    render(withMessages(await VpnDevicesPage(), locale));
}

describe("VPN devices page, device mesh off", () => {
    it.each(["en-US", "es-ES"] as const)("names no third-party client (%s)", async (locale) => {
        vpnAppDevicesAction.mockResolvedValue({ devices: [] });
        await draw(locale);
        await screen.findByText(locale === "en-US" ? "No devices yet" : "Sin dispositivos");
        expect(document.body.textContent).not.toMatch(/tailscale|headscale/i);
        expect(listVpnDevicesAction).not.toHaveBeenCalled();
    });

    it("lists the devices that connect from the Polaris apps, and how to get them", async () => {
        vpnAppDevicesAction.mockResolvedValue({ devices: [DEVICE] });
        await draw();
        expect(await screen.findByText("fixture-laptop")).toBeTruthy();
        expect(screen.getByText("Fixture Person")).toBeTruthy();
        const link = screen.getByRole("link", { name: "Get the apps" });
        expect(link.getAttribute("href")).toBe("/account/downloads");
        expect(document.body.textContent).not.toMatch(/tailscale|headscale/i);
    });
});

describe("VPN devices page, device mesh on", () => {
    it("adds the mesh's own list", async () => {
        state.mesh = true;
        vpnAppDevicesAction.mockResolvedValue({ devices: [] });
        listVpnDevicesAction.mockResolvedValue({ devices: [], mayJoin: true });
        await draw();
        expect(screen.getByText("mesh.devicesTitle")).toBeTruthy();
        await vi.waitFor(() => expect(listVpnDevicesAction).toHaveBeenCalled());
    });
});

describe("default VPN copy", () => {
    // What every reader of /vpn and /vpn/devices is shown, mesh or not.
    it.each([
        ["en-US", enVpn],
        ["es-ES", esVpn]
    ])("names no third-party client (%s)", (_locale, catalog) => {
        const shown = JSON.stringify([catalog.connect, catalog.appDevices, catalog.access]);
        expect(shown).not.toMatch(/tailscale|headscale/i);
    });
});
