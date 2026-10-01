// @vitest-environment jsdom

/**
 * The uploads screen's card for storages on the local network.
 *
 * What it has to get right is the hand-off the operator makes when Polaris
 * cannot prove a device on its own: it lists who answers, a press on one asks
 * the server, and the server's "this has never said who it is - use it anyway?"
 * is shown and confirmed before the password goes there. And "Find it again"
 * runs the search now.
 */

import fs from "node:fs";
import path from "node:path";
import { withMessages } from "../setup/i18n";
import type { WhereaboutsView } from "@/lib/storage-whereabouts/follow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const findStorageAgainAction = vi.fn();
const setStorageAddressAction = vi.fn();

vi.mock("@/app/(app)/admin/uploads/actions", () => ({ findStorageAgainAction, setStorageAddressAction }));

const { NetworkStorageCard } = await import("@/app/(app)/admin/uploads/network-card");

const ID = "018f2b7a-0000-7000-8000-0000000000f6";

const unknown: WhereaboutsView = {
    id: ID,
    name: "UNAS Pro",
    address: "192.168.1.129",
    remembered: null,
    last: {
        at: "2026-10-01T12:05:00.000Z",
        outcome: {
            kind: "candidates",
            candidates: [{ address: "192.168.1.134", label: "UNAS-PRO", mac: "6c:63:f8:6e:53:50" }]
        }
    }
};

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("storage on the network", () => {
    it("asks before using a device it cannot prove, then uses it", async () => {
        setStorageAddressAction.mockResolvedValueOnce({ confirm: { device: "UNAS-PRO" } });
        setStorageAddressAction.mockResolvedValueOnce({
            view: {
                ...unknown,
                address: "192.168.1.134",
                remembered: { mac: "6c:63:f8:6e:53:50", label: "UNAS-PRO", seenAt: "2026-10-01T12:06:00.000Z" },
                last: null
            }
        });
        render(withMessages(<NetworkStorageCard storages={[unknown]} />));

        expect(screen.getByText("Not known yet: Polaris learns who it is the next time it answers.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Use this one" }));
        expect(await screen.findByText(/cannot prove this is it, and its password will be sent there/)).toBeTruthy();
        expect(setStorageAddressAction).toHaveBeenLastCalledWith({ id: ID, address: "192.168.1.134", accept: false });

        fireEvent.click(screen.getByRole("button", { name: "Use it" }));
        expect(await screen.findByText("Known as UNAS-PRO (6c:63:f8:6e:53:50).", { exact: false })).toBeTruthy();
        expect(setStorageAddressAction).toHaveBeenLastCalledWith({ id: ID, address: "192.168.1.134", accept: true });
        expect((screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe("192.168.1.134");
    });

    it("says why an address was refused", async () => {
        setStorageAddressAction.mockResolvedValueOnce({
            error: "A different device answers at 192.168.1.50 (OTHER), so the password of UNAS Pro is not sent there."
        });
        render(withMessages(<NetworkStorageCard storages={[unknown]} />));

        const field = screen.getByRole("textbox", { name: "Address" });
        fireEvent.change(field, { target: { value: "192.168.1.50" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(/A different device answers at 192.168.1.50/)).toBeTruthy();
    });

    it("will not save an address that is not on a local network", () => {
        render(withMessages(<NetworkStorageCard storages={[unknown]} />));
        fireEvent.change(screen.getByRole("textbox", { name: "Address" }), { target: { value: "8.8.8.8" } });
        expect(screen.getByText("Write an address on this network, like 192.168.1.30")).toBeTruthy();
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("looks again on demand and shows where it was followed to", async () => {
        findStorageAgainAction.mockResolvedValueOnce({
            view: {
                ...unknown,
                address: "192.168.1.134",
                last: {
                    at: "2026-10-01T12:07:00.000Z",
                    outcome: { kind: "followed", from: "192.168.1.129", to: "192.168.1.134", mac: "6c:63:f8:6e:53:50" }
                }
            }
        });
        render(withMessages(<NetworkStorageCard storages={[unknown]} />));
        fireEvent.click(screen.getByRole("button", { name: "Find it again" }));
        expect(
            await screen.findByText(
                "Moved from 192.168.1.129 to 192.168.1.134, and Polaris follows it. Reserve 192.168.1.134 for 6c:63:f8:6e:53:50 in your router so it stays there."
            )
        ).toBeTruthy();
        expect(findStorageAgainAction).toHaveBeenCalledWith(ID);
    });

    it("names the device holding the address when the storage is not found anywhere else", () => {
        const impostor: WhereaboutsView = {
            ...unknown,
            last: {
                at: "2026-10-01T12:08:00.000Z",
                outcome: { kind: "impostor", address: "192.168.1.129", label: "DESKTOP-7" }
            }
        };
        const { container } = render(withMessages(<NetworkStorageCard storages={[impostor]} />));
        expect(
            screen.getByText(
                "A different device answers at 192.168.1.129 (DESKTOP-7), so its password is not sent there, and it was not found anywhere else on the network."
            )
        ).toBeTruthy();

        const evidenceDir = process.env.ENIGMA_GATE_EVIDENCE_DIR;
        if (evidenceDir) {
            fs.mkdirSync(evidenceDir, { recursive: true });
            fs.writeFileSync(
                path.join(evidenceDir, "network-card-impostor.html"),
                `<!doctype html><html><head><meta charset="utf-8"><title>impostor outcome - admin uploads card</title></head><body>${container.innerHTML}</body></html>`
            );
        }
    });

    it("is drawn in Spanish", () => {
        render(withMessages(<NetworkStorageCard storages={[unknown]} />, "es-ES"));
        expect(screen.getByText("Almacenamiento en la red")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Buscarlo" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Usar este" })).toBeTruthy();
        expect(screen.queryByText("Storage on the network")).toBeNull();
    });
});
