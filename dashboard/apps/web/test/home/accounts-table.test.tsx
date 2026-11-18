// @vitest-environment jsdom

/**
 * The connected accounts as a table: a row per account with its state and why,
 * searched, filtered and sorted, with every action the old cards had in the
 * row's menu and a row press narrowing the devices to that account.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceAccountView } from "@polaris-app/places/src/lib/device-accounts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
    AccountsTable,
    type AccountsTableProps
} from "@polaris-app/places/src/screens/devices/accounts-table";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

function account(overrides: Partial<DeviceAccountView>): DeviceAccountView {
    return {
        id: "fixture-account",
        brand: "Nuki",
        connection: "nuki-web",
        connectionLabel: "Nuki Web",
        label: "Fixture account",
        status: "ok",
        statusNote: "",
        lastSyncedAt: "2026-01-02T10:00:00.000Z",
        settings: {},
        options: {},
        deviceCount: 1,
        ...overrides
    };
}

const accounts = [
    account({ id: "a", label: "Front door locks", deviceCount: 3 }),
    account({
        id: "b",
        brand: "PETKIT",
        connection: "petkit-cloud",
        connectionLabel: "PETKIT account",
        label: "Cat litter",
        status: "unauthorized",
        statusNote: "fixture: token revoked",
        options: { takeBack: true },
        deviceCount: 1
    }),
    account({ id: "c", label: "Back door locks", deviceCount: 2, lastSyncedAt: null })
];

function props(overrides: Partial<AccountsTableProps> = {}): AccountsTableProps {
    return {
        accounts,
        canManage: true,
        shownAccountId: null,
        onShowDevices: vi.fn(),
        onReconnect: vi.fn(),
        onConnect: vi.fn(),
        onLink: vi.fn(),
        onAdjust: vi.fn(),
        onDisconnect: vi.fn(),
        ...overrides
    };
}

/** The account names in the order the table draws them. */
function names(): string[] {
    const table = screen.getByRole("table", { name: "Connected accounts" });
    return within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("button")[0]!.textContent ?? "");
}

async function openMenu(name: string): Promise<void> {
    fireEvent.keyDown(screen.getByRole("button", { name: `More for ${name}` }), { key: "Enter" });
    await act(async () => {
        await Promise.resolve();
    });
}

afterEach(cleanup);

describe("connected accounts table", () => {
    it("draws a row per account with its state, the reason and the device count", () => {
        render(<AccountsTable {...props()} />);
        expect(names()).toEqual(["Back door locks", "Cat litter", "Front door locks"]);
        const row = screen.getByRole("button", { name: "Cat litter" }).closest("tr")!;
        expect(within(row).getByText("Needs reconnecting")).toBeTruthy();
        expect(within(row).getByText("fixture: token revoked")).toBeTruthy();
        const back = screen.getByRole("button", { name: "Back door locks" }).closest("tr")!;
        expect(within(back).getAllByText(/not checked yet/).length).toBeGreaterThan(0);
    });

    it("searches, filters by state and sorts by a column", () => {
        render(<AccountsTable {...props()} />);
        fireEvent.change(screen.getByRole("searchbox", { name: "Search accounts" }), {
            target: { value: "door" }
        });
        expect(names()).toEqual(["Back door locks", "Front door locks"]);

        fireEvent.change(screen.getByRole("searchbox", { name: "Search accounts" }), {
            target: { value: "nothing like it" }
        });
        expect(screen.getByText("No account matches")).toBeTruthy();
        fireEvent.change(screen.getByRole("searchbox", { name: "Search accounts" }), {
            target: { value: "" }
        });

        fireEvent.click(screen.getByRole("button", { name: "Devices" }));
        expect(names()).toEqual(["Cat litter", "Back door locks", "Front door locks"]);
        fireEvent.click(screen.getByRole("button", { name: "Devices" }));
        expect(names()).toEqual(["Front door locks", "Back door locks", "Cat litter"]);
        expect(
            screen.getByRole("columnheader", { name: "Devices" }).getAttribute("aria-sort")
        ).toBe("descending");

        fireEvent.click(screen.getByRole("button", { name: "Status" }));
        expect(names()[0]).toBe("Cat litter");
    });

    it("carries the card's actions in the row menu", async () => {
        const p = props();
        render(<AccountsTable {...p} />);
        await openMenu("Cat litter");
        fireEvent.click(screen.getByRole("menuitem", { name: "Reconnect" }));
        expect(p.onReconnect).toHaveBeenCalledWith(accounts[1]);

        await openMenu("Cat litter");
        fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
        expect(p.onAdjust).toHaveBeenCalledWith("b");

        await openMenu("Front door locks");
        expect(screen.queryByRole("menuitem", { name: "Reconnect" })).toBeNull();
        fireEvent.click(screen.getByRole("menuitem", { name: "Connect locally" }));
        expect(p.onLink).toHaveBeenCalledWith(accounts[0]);

        await openMenu("Front door locks");
        fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
        expect(p.onDisconnect).toHaveBeenCalledWith(accounts[0]);
    });

    it("offers nothing that changes an account to somebody who cannot manage", async () => {
        render(<AccountsTable {...props({ canManage: false })} />);
        await openMenu("Cat litter");
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
            "Show its devices"
        ]);
    });

    it("narrows the devices to the account when its row is pressed", () => {
        const onShowDevices = vi.fn();
        const { rerender } = render(<AccountsTable {...props({ onShowDevices })} />);
        fireEvent.click(screen.getByText("Needs reconnecting").closest("td")!);
        expect(onShowDevices).toHaveBeenLastCalledWith("b");
        rerender(<AccountsTable {...props({ onShowDevices, shownAccountId: "b" })} />);
        fireEvent.click(screen.getByRole("button", { name: "Cat litter" }));
        expect(onShowDevices).toHaveBeenLastCalledWith(null);
    });
});
