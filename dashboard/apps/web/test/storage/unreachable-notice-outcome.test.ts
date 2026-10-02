/**
 * The "storage is not reachable" notice says what looking for it found.
 *
 * Before, it said "check that the device is on and connected" whatever the
 * truth was. Now Polaris looks first: a NAS that moved is followed and announced
 * as moved (with the hardware address to reserve in the router), one that is
 * nowhere is said to be off or disconnected, and one Polaris cannot prove is
 * named by who answers instead - in each administrator's own language.
 */

import { translatorFor } from "@/lib/i18n/translate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchOutcome } from "@/lib/storage-whereabouts/follow";

const ID = "018f2b7a-0000-7000-8000-0000000000e5";
const notify = vi.fn(async () => undefined);
let outcome: SearchOutcome;
let locale: "en-US" | "es-ES" = "en-US";

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: { user: { findMany: vi.fn(async () => [{ id: "admin-1" }]) } }
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: vi.fn(async (_user: string, namespace: "notices") => translatorFor(locale, namespace))
}));
vi.mock("@/lib/storage-whereabouts/follow", () => ({ searchFor: vi.fn(async () => outcome) }));

const alert = await import("@/lib/storage-alert");

beforeEach(() => {
    vi.clearAllMocks();
    locale = "en-US";
    alert.storageAnswered(ID);
});

function said(): { title: string; body: string; event: string } {
    return (
        notify.mock.calls.at(-1) as unknown as [{ title: string; body: string; event: string }]
    )[0];
}

describe("the unreachable notice", () => {
    it("says it is off or disconnected when it is nowhere on the network", async () => {
        outcome = { kind: "gone", address: "10.0.1.129" };
        await alert.reportStorageUnreachable({ id: ID, name: "Office NAS" });
        expect(said().event).toBe("storage.unreachable");
        expect(said().body).toMatch(/not answering anywhere, so it is off or disconnected/);
    });

    it("names who answers when Polaris cannot prove which device it is", async () => {
        outcome = {
            kind: "candidates",
            candidates: [{ address: "10.0.1.134", label: "OFFICE-NAS", mac: "00:00:5e:00:53:50" }]
        };
        await alert.reportStorageUnreachable({ id: ID, name: "Office NAS" });
        expect(said().body).toContain(
            "An SMB server answers on the network, the first at 10.0.1.134 (OFFICE-NAS)"
        );
    });

    it("is not sent at all when the search found it and followed it", async () => {
        outcome = {
            kind: "followed",
            from: "10.0.1.129",
            to: "10.0.1.134",
            mac: "00:00:5e:00:53:50"
        };
        await alert.reportStorageUnreachable({ id: ID, name: "Office NAS" });
        expect(notify).not.toHaveBeenCalled();
    });

    it("is still sent when the device answers where it is but would not take the file", async () => {
        outcome = { kind: "answering", address: "10.0.1.129" };
        await alert.reportStorageUnreachable({ id: ID, name: "Office NAS" });
        expect(said().event).toBe("storage.unreachable");
        expect(said().body).toContain("It answers at 10.0.1.129, but would not take the file");
    });

    it("names the device that holds the address when the storage is not found elsewhere", async () => {
        outcome = { kind: "impostor", address: "10.0.1.129", label: "DESKTOP-7" };
        await alert.reportStorageUnreachable({ id: ID, name: "Office NAS" });
        expect(said().body).toContain("A different device answers at 10.0.1.129 (DESKTOP-7)");
        expect(said().body).not.toMatch(/off or disconnected/);
    });

    it("is written in the administrator's language", async () => {
        locale = "es-ES";
        outcome = { kind: "gone", address: "10.0.1.129" };
        await alert.reportStorageUnreachable({ id: ID, name: "Office NAS" });
        expect(said().body).toMatch(/apagado o desconectado/);
    });
});

describe("the moved notice", () => {
    it("says where it went and names the hardware address to reserve", async () => {
        await alert.reportStorageMoved({
            id: ID,
            name: "Office NAS",
            from: "10.0.1.129",
            to: "10.0.1.134",
            mac: "00:00:5e:00:53:50"
        });
        expect(said()).toMatchObject({
            event: "storage.moved",
            title: "Office NAS moved to a new address"
        });
        expect(said().body).toBe(
            "Office NAS moved from 10.0.1.129 to 10.0.1.134 on your network, and Polaris follows it there now. So it does not move again, reserve 10.0.1.134 for the device 00:00:5e:00:53:50 in your router's DHCP settings."
        );
    });
});
