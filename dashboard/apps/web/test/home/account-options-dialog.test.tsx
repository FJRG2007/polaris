// @vitest-environment jsdom

/**
 * The switches a connected account can be changed by: shown with what they do,
 * flipped at once, and put back with the reason when the server refuses.
 */

import type { DeviceAccountView } from "@polaris-app/places/src/lib/device-accounts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountOptionsDialog } from "@polaris-app/places/src/screens/devices/account-options-dialog";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

const answers: { account?: DeviceAccountView; error?: string }[] = [];
const sent: unknown[] = [];

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    setDeviceAccountOptionAction: async (input: unknown) => {
        sent.push(input);
        return answers.shift() ?? { error: "fixture: no answer" };
    }
}));

const account: DeviceAccountView = {
    id: "0190a6d2-0000-7000-8000-000000000001",
    brand: "PETKIT",
    connection: "petkit-cloud",
    connectionLabel: "PETKIT account",
    label: "Fixture litter",
    status: "ok",
    statusNote: "",
    lastSyncedAt: null,
    settings: {},
    options: { takeBack: true },
    deviceCount: 1
};

afterEach(() => {
    cleanup();
    answers.length = 0;
    sent.length = 0;
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe("account options", () => {
    it("explains the switch and sends the change", async () => {
        const changed = vi.fn();
        answers.push({ account: { ...account, options: { takeBack: false } } });
        render(<AccountOptionsDialog account={account} onClose={() => {}} onChanged={changed} />);
        expect(screen.getByText(/one sign-in per account/)).toBeTruthy();
        const toggle = screen.getByRole("switch", { name: "Take the session back" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");

        fireEvent.click(toggle);
        await settle();
        expect(sent).toEqual([{ accountId: account.id, key: "takeBack", on: false }]);
        // Shown off at once, then as the server answered.
        expect(changed.mock.calls[0]![0].options.takeBack).toBe(false);
        expect(changed.mock.calls.at(-1)![0].options.takeBack).toBe(false);
    });

    it("puts the switch back and says why when the server refuses", async () => {
        const changed = vi.fn();
        answers.push({ error: "That connection has no such setting" });
        render(<AccountOptionsDialog account={account} onClose={() => {}} onChanged={changed} />);
        fireEvent.click(screen.getByRole("switch", { name: "Take the session back" }));
        await settle();
        expect(changed.mock.calls.at(-1)![0]).toBe(account);
        expect(screen.getByRole("alert").textContent).toBeTruthy();
    });
});
