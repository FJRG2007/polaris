/**
 * A domain on the backup path is compared with that path, not with a line that
 * takes no visitors, and a new record never names that line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn();
const detectPublicIp = vi.fn();
vi.mock("@/lib/setting-store", () => ({ getSetting }));
vi.mock("@/lib/network-service", () => ({ detectPublicIp }));

const { expectedPublicAddress, publishableAddress } = await import("@/lib/serving-address");

const records = (target: unknown) => JSON.stringify({ zoneId: "zone", target, originals: [] });

beforeEach(() => {
    getSetting.mockReset();
    detectPublicIp.mockReset();
    detectPublicIp.mockResolvedValue("192.0.2.1");
});

describe("the address a domain is expected at", () => {
    it("is the line's own while nothing else holds the records", async () => {
        getSetting.mockResolvedValue(null);
        expect(await expectedPublicAddress(true)).toBe("192.0.2.1");
        expect(detectPublicIp).toHaveBeenCalledWith(true);
        expect(await publishableAddress()).toBe("192.0.2.1");
    });

    it("is the relay's while the relay holds them", async () => {
        getSetting.mockResolvedValue(records({ kind: "relay", address: "198.51.100.7" }));
        expect(await expectedPublicAddress()).toBe("198.51.100.7");
        expect(await publishableAddress()).toBe("198.51.100.7");
        expect(detectPublicIp).not.toHaveBeenCalled();
    });

    it("cannot be named while a tunnel holds them, but a new record names the line", async () => {
        getSetting.mockResolvedValue(records({ kind: "tunnel", tunnelId: "fixture" }));
        expect(await expectedPublicAddress()).toBeNull();
        expect(await publishableAddress()).toBe("192.0.2.1");
    });

    it("treats an unreadable setting as nothing holding them", async () => {
        getSetting.mockResolvedValue("not json");
        expect(await expectedPublicAddress()).toBe("192.0.2.1");
    });
});
