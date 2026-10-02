// @vitest-environment jsdom

/**
 * Picking a make the way Home Assistant's "add integration" does: a search box
 * over every make with its logo, a strict match (a word found nowhere leaves
 * nothing), and the form only once a make is picked, with a way back.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    startDevicePairingAction: async () => ({}),
    pollDevicePairingAction: async () => ({}),
    connectDeviceAccountAction: async () => ({}),
    reconnectDeviceAccountAction: async () => ({})
}));

const { ConnectDialog } = await import("@polaris-app/places/src/screens/devices/connect-dialog");

afterEach(cleanup);

function drawn() {
    render(
        withMessages(
            <ConnectDialog open reconnect={null} onClose={() => {}} onConnected={() => {}} />
        )
    );
    return screen.getByRole("searchbox");
}

function listed(): string[] {
    const list = screen.queryByRole("list");
    if (!list) return [];
    return within(list)
        .getAllByRole("button")
        .map((button) => button.querySelector("[title]")?.getAttribute("title") ?? "");
}

describe("the make picker", () => {
    it("lists every make, alphabetically, before anything is typed", () => {
        drawn();
        const names = listed();
        expect(names.length).toBeGreaterThan(5);
        expect(names).toContain("Nuki");
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        expect(names).toEqual(sorted);
    });

    it("shows nothing for a word no make has, and says so", () => {
        const search = drawn();
        fireEvent.change(search, { target: { value: "zzqx" } });
        expect(listed()).toEqual([]);
        expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    });

    it("finds a make by what it brings in, ignoring case and accents", () => {
        const search = drawn();
        fireEvent.change(search, { target: { value: "AIR PURIFIER" } });
        const names = listed();
        expect(names).toContain("Philips");
        expect(names).not.toContain("Nuki");
        fireEvent.change(search, { target: { value: "shélly" } });
        // A make whose name starts with the query leads the list.
        expect(listed()[0]).toBe("Shelly");
    });

    it("needs every word to match", () => {
        const search = drawn();
        fireEvent.change(search, { target: { value: "nuki light" } });
        expect(listed()).toEqual([]);
    });

    it("opens the form for the picked make and goes back with Change", () => {
        const search = drawn();
        fireEvent.change(search, { target: { value: "nuki" } });
        fireEvent.keyDown(search, { key: "Enter" });
        expect(screen.queryByRole("searchbox")).toBeNull();
        expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Change" }));
        expect(screen.getByRole("searchbox")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    });
});
