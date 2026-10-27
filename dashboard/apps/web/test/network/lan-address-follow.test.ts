/**
 * Following this server's own LAN address.
 *
 * A move is recorded once, the certificate and the DNS server follow it, and the
 * administrators are told where Polaris is now. A step that fails never stops the
 * others, and an address that is briefly unknown is not a move.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: { user: { findMany: async () => [] } } }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => () => "" }));
vi.mock("@/lib/notification-service", () => ({ createNotification: async () => undefined }));
vi.mock("@/lib/host-address", () => ({
    getHostLanIp: async () => null,
    getHostLanIps: async () => []
}));

const { followLanAddress, lanAddressChange, CALLS_LAN_KEY, LAN_ADDRESS_KEY, LAN_HISTORY_KEY } =
    await import("@/lib/lan-address-follow");

function harness(
    current: string | null,
    last: string | null,
    dnsMoves = false,
    held: string[] = []
) {
    const store = new Map<string, string>(last ? [[LAN_ADDRESS_KEY, last]] : []);
    const steps = {
        current: vi.fn(async () => current),
        held: vi.fn(async () => (current ? [current, ...held] : held)),
        read: vi.fn(async (key: string) => store.get(key) ?? null),
        write: vi.fn(async (key: string, value: string) => {
            store.set(key, value);
        }),
        dns: vi.fn(async () => (dnsMoves && last && current ? { from: last, to: current } : null)),
        certificate: vi.fn(async () => undefined),
        calls: vi.fn(async () => true),
        announce: vi.fn(async () => undefined)
    };
    return { steps, store };
}

describe("lanAddressChange", () => {
    it("tells a first sighting, a move and nothing apart", () => {
        expect(lanAddressChange(null, "192.168.1.20")).toEqual({
            kind: "first",
            to: "192.168.1.20"
        });
        expect(lanAddressChange("192.168.1.20", "10.0.0.5")).toEqual({
            kind: "moved",
            from: "192.168.1.20",
            to: "10.0.0.5"
        });
        expect(lanAddressChange("192.168.1.20", "192.168.1.20")).toEqual({ kind: "none" });
    });

    it("does not treat an unknown address as the machine leaving", () => {
        expect(lanAddressChange("192.168.1.20", null)).toEqual({ kind: "none" });
    });

    it("does not treat a change of preferred link as a move while the old address is held", () => {
        expect(
            lanAddressChange("192.168.1.20", "192.168.1.31", ["192.168.1.31", "192.168.1.20"])
        ).toEqual({
            kind: "none"
        });
        expect(lanAddressChange("192.168.1.20", "192.168.1.31", ["192.168.1.31"])).toEqual({
            kind: "moved",
            from: "192.168.1.20",
            to: "192.168.1.31"
        });
    });
});

describe("followLanAddress", () => {
    it("on a move: records it, reissues the certificate, moves DNS and announces once", async () => {
        const { steps, store } = harness("10.0.0.5", "192.168.1.20", true);
        const result = await followLanAddress(steps);
        expect(result).toEqual({
            change: { kind: "moved", from: "192.168.1.20", to: "10.0.0.5" },
            dnsMoved: true
        });
        expect(store.get(LAN_ADDRESS_KEY)).toBe("10.0.0.5");
        expect(JSON.parse(store.get(LAN_HISTORY_KEY) ?? "[]")[0]).toMatchObject({
            from: "192.168.1.20",
            to: "10.0.0.5"
        });
        expect(steps.certificate).toHaveBeenCalledOnce();
        expect(steps.announce).toHaveBeenCalledWith("192.168.1.20", "10.0.0.5", true);

        // The next pass finds it settled.
        steps.announce.mockClear();
        steps.certificate.mockClear();
        await followLanAddress(steps);
        expect(steps.announce).not.toHaveBeenCalled();
        expect(steps.certificate).not.toHaveBeenCalled();
    });

    it("on first sight: remembers the address and announces nothing", async () => {
        const { steps, store } = harness("192.168.1.20", null);
        await followLanAddress(steps);
        expect(store.get(LAN_ADDRESS_KEY)).toBe("192.168.1.20");
        expect(steps.announce).not.toHaveBeenCalled();
    });

    it("checks the DNS server on every pass, so one left behind is repaired", async () => {
        const { steps } = harness("192.168.1.20", "192.168.1.20");
        await followLanAddress(steps);
        expect(steps.dns).toHaveBeenCalledOnce();
    });

    it("keeps going when the DNS server or the certificate fails", async () => {
        const { steps } = harness("10.0.0.5", "192.168.1.20");
        steps.dns.mockRejectedValueOnce(new Error("deploy failed"));
        steps.certificate.mockRejectedValueOnce(new Error("no openssl"));
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const result = await followLanAddress(steps);
        errors.mockRestore();
        expect(result.dnsMoved).toBe(false);
        expect(steps.announce).toHaveBeenCalledWith("192.168.1.20", "10.0.0.5", false);
    });

    it("announces nothing when the preferred link changes but the old address is still held", async () => {
        const { steps, store } = harness("192.168.1.31", "192.168.1.20", false, ["192.168.1.20"]);
        await followLanAddress(steps);
        expect(store.get(LAN_ADDRESS_KEY)).toBe("192.168.1.20");
        expect(steps.certificate).not.toHaveBeenCalled();
        expect(steps.announce).not.toHaveBeenCalled();
        expect(steps.dns).toHaveBeenCalledOnce();
    });

    it("does nothing but check DNS while the address is unknown", async () => {
        const { steps, store } = harness(null, "192.168.1.20");
        await followLanAddress(steps);
        expect(store.get(LAN_ADDRESS_KEY)).toBe("192.168.1.20");
        expect(steps.write).not.toHaveBeenCalled();
        expect(steps.announce).not.toHaveBeenCalled();
    });
});

describe("the call server following the preferred address", () => {
    it("records the address on first sight without restarting anything", async () => {
        const { steps, store } = harness("192.168.1.142", "192.168.1.142");
        await followLanAddress(steps);
        expect(store.get(CALLS_LAN_KEY)).toBe("192.168.1.142");
        expect(steps.calls).not.toHaveBeenCalled();
    });

    it("restarts it when cable and WiFi trade places, even with both held", async () => {
        const { steps, store } = harness("192.168.1.149", "192.168.1.142", false, [
            "192.168.1.142"
        ]);
        store.set(CALLS_LAN_KEY, "192.168.1.142");
        await followLanAddress(steps);
        expect(steps.calls).toHaveBeenCalledOnce();
        expect(store.get(CALLS_LAN_KEY)).toBe("192.168.1.149");
        // Not a move: nobody is told, and the next pass is quiet.
        expect(steps.announce).not.toHaveBeenCalled();
        await followLanAddress(steps);
        expect(steps.calls).toHaveBeenCalledOnce();
    });

    it("restarts it on a move", async () => {
        const { steps, store } = harness("10.0.0.5", "192.168.1.20");
        store.set(CALLS_LAN_KEY, "192.168.1.20");
        await followLanAddress(steps);
        expect(steps.calls).toHaveBeenCalledOnce();
        expect(steps.announce).toHaveBeenCalledOnce();
    });

    it("tries again on the next pass when the restart failed", async () => {
        const { steps, store } = harness("192.168.1.149", "192.168.1.149");
        store.set(CALLS_LAN_KEY, "192.168.1.142");
        steps.calls.mockResolvedValueOnce(false);
        await followLanAddress(steps);
        expect(store.get(CALLS_LAN_KEY)).toBe("192.168.1.142");
        await followLanAddress(steps);
        expect(steps.calls).toHaveBeenCalledTimes(2);
        expect(store.get(CALLS_LAN_KEY)).toBe("192.168.1.149");
    });

    it("does not let a failing restart stop the rest of the pass", async () => {
        const { steps, store } = harness("10.0.0.5", "192.168.1.20");
        store.set(CALLS_LAN_KEY, "192.168.1.20");
        steps.calls.mockRejectedValueOnce(new Error("no engine"));
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await followLanAddress(steps);
        errors.mockRestore();
        expect(steps.certificate).toHaveBeenCalledOnce();
        expect(steps.announce).toHaveBeenCalledOnce();
    });

    it("leaves it alone while the address is unknown", async () => {
        const { steps, store } = harness(null, "192.168.1.20");
        store.set(CALLS_LAN_KEY, "192.168.1.20");
        await followLanAddress(steps);
        expect(steps.calls).not.toHaveBeenCalled();
    });
});
