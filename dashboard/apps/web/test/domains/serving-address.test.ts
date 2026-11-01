/**
 * A domain on the backup path is compared with that path, not with a line that
 * takes no visitors, and a new record never names that line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn();
const detectPublicIp = vi.fn();
vi.mock("@/lib/setting-store", () => ({ getSetting }));
vi.mock("@/lib/network-service", () => ({ detectPublicIp }));

const { acceptedAddresses, expectedPublicAddress, publishableAddress, publishedPortAddress } =
    await import("@/lib/serving-address");

const LINE = "51.0.0.1";
const RELAY = "51.0.0.7";
const records = (target: unknown) => JSON.stringify({ zoneId: "zone", target, originals: [] });

function stored(values: { records?: string; reach?: unknown }) {
    getSetting.mockImplementation(async (key: string) => {
        if (key === "backupAccess.records") return values.records ?? null;
        return key === "network.inboundReach" && values.reach ? JSON.stringify(values.reach) : null;
    });
}

const carrierNat = {
    checkedAt: "2026-01-01T00:00:00.000Z",
    publicIp: LINE,
    cgnat: true,
    certain: true,
    reason: null,
    inboundProven: false
};

beforeEach(() => {
    getSetting.mockReset();
    detectPublicIp.mockReset();
    detectPublicIp.mockResolvedValue(LINE);
});

describe("the address a domain is expected at", () => {
    it("is the line's own while nothing else holds the records", async () => {
        getSetting.mockResolvedValue(null);
        expect(await expectedPublicAddress(true)).toBe(LINE);
        expect(detectPublicIp).toHaveBeenCalledWith(true);
        expect(await publishableAddress()).toBe(LINE);
    });

    it("is the relay's while the relay holds them", async () => {
        getSetting.mockResolvedValue(records({ kind: "relay", address: RELAY }));
        expect(await expectedPublicAddress()).toBe(RELAY);
        expect(await publishableAddress()).toBe(RELAY);
        expect(detectPublicIp).not.toHaveBeenCalled();
    });

    it("may be either for a name the flip did not move", async () => {
        stored({ records: records({ kind: "relay", address: RELAY }) });
        expect(await acceptedAddresses()).toEqual([RELAY, LINE]);
        stored({ records: records({ kind: "tunnel", tunnelId: "fixture" }) });
        expect(await acceptedAddresses()).toEqual([LINE]);
        detectPublicIp.mockRejectedValue(new Error("offline"));
        expect(await acceptedAddresses()).toEqual([]);
    });

    it("is the line's for a published port, which no backup path carries", async () => {
        stored({ records: records({ kind: "relay", address: RELAY }) });
        expect(await publishedPortAddress()).toBe(LINE);
    });

    it("is never a line behind a carrier while a backup holds the records", async () => {
        stored({ records: records({ kind: "relay", address: RELAY }), reach: carrierNat });
        expect(await publishedPortAddress()).toBeNull();
        stored({ records: records({ kind: "tunnel", tunnelId: "fixture" }), reach: carrierNat });
        expect(await publishableAddress()).toBeNull();
    });

    it("cannot be named while a tunnel holds them, but a new record names the line", async () => {
        stored({ records: records({ kind: "tunnel", tunnelId: "fixture" }) });
        expect(await expectedPublicAddress()).toBeNull();
        expect(await publishableAddress()).toBe(LINE);
    });

    it("treats an unreadable setting as nothing holding them", async () => {
        getSetting.mockResolvedValue("not json");
        expect(await expectedPublicAddress()).toBe(LINE);
    });
});
