import { beforeEach, describe, expect, it, vi } from "vitest";
import { INBOUND_KEY, type InboundReach } from "../../src/lib/backup-access/inbound";

// Fixture addresses, public-looking on purpose (see inbound.test.ts).
const FIBRE = "88.0.0.10";
const STARLINK = "98.97.0.20";

const settings = new Map<string, string | null>();
const ptr = new Map<string, string[]>();
const redetected = vi.fn(async () => "home-nat");

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => void settings.set(key, value)
}));
vi.mock("@/lib/domain-service", () => ({ getPublicIp: async () => "192.168.1.10" }));
vi.mock("@/lib/network-service", () => ({ detectLocalEnvironment: redetected }));
vi.mock("node:dns/promises", () => ({ reverse: async (ip: string) => ptr.get(ip) ?? [] }));
/** The router's WAN address as the responder last wrote it, and when. */
const wan = { ip: null as string | null, writtenAt: new Date(0) };
vi.mock("@/lib/host-address", () => ({
    getRouterWanIp: async (notBefore?: Date | null) =>
        notBefore && wan.writtenAt < notBefore ? null : wan.ip
}));
vi.mock("@/lib/network/stun", () => ({ stunMappedIp: async () => null }));

const { refreshInboundReach } = await import("../../src/lib/backup-access/inbound-service");

const stored = (): InboundReach => JSON.parse(settings.get(INBOUND_KEY) ?? "null") as InboundReach;

beforeEach(() => {
    settings.clear();
    ptr.clear();
    redetected.mockClear();
    wan.ip = null;
    wan.writtenAt = new Date(0);
});

describe("refreshInboundReach", () => {
    it("stores the verdict and re-detects the environment on a first sighting", async () => {
        const reach = await refreshInboundReach({ publicIp: FIBRE, outside: "up", hairpin: false });
        expect(reach).toMatchObject({ publicIp: FIBRE, cgnat: false, inboundProven: true });
        expect(stored()).toMatchObject({ publicIp: FIBRE, uplinkChangedAt: null });
        expect(redetected).toHaveBeenCalledWith(true);
    });

    it("keeps proof from outside through a pass the outside machine missed, for the same address", async () => {
        ptr.set(STARLINK, ["customer.x.pop.starlinkisp.net"]);
        await refreshInboundReach({ publicIp: STARLINK, outside: "up", hairpin: false });
        redetected.mockClear();
        const reach = await refreshInboundReach({
            publicIp: STARLINK,
            outside: null,
            hairpin: false
        });
        expect(reach).toMatchObject({ cgnat: false, inboundProven: true });
        expect(redetected).not.toHaveBeenCalled();
    });

    it("lets an outside check that cannot get in end an earlier proof", async () => {
        await refreshInboundReach({ publicIp: FIBRE, outside: "up", hairpin: true });
        const reach = await refreshInboundReach({
            publicIp: FIBRE,
            outside: "down",
            hairpin: true
        });
        expect(reach).toMatchObject({ cgnat: true, reason: "no-inbound", inboundProven: false });
        expect(redetected).toHaveBeenCalledTimes(2);
    });

    it("does not carry proof over to a new address, and marks the uplink change", async () => {
        await refreshInboundReach({ publicIp: FIBRE, outside: "up", hairpin: false });
        ptr.set(STARLINK, ["customer.x.pop.starlinkisp.net"]);
        redetected.mockClear();
        const reach = await refreshInboundReach({
            publicIp: STARLINK,
            outside: null,
            hairpin: true
        });
        expect(reach).toMatchObject({ publicIp: STARLINK, cgnat: true, reason: "starlink" });
        expect(reach?.uplinkChangedAt).not.toBeNull();
        expect(redetected).toHaveBeenCalledWith(true);
    });

    it("does not read the router's WAN from before the line's address moved", async () => {
        const OTHER = "88.0.0.20";
        wan.ip = FIBRE;
        wan.writtenAt = new Date(Date.now() - 60_000);
        await refreshInboundReach({ publicIp: FIBRE, outside: null, hairpin: false });
        const moved = await refreshInboundReach({ publicIp: OTHER, outside: null, hairpin: false });
        expect(moved).toMatchObject({ publicIp: OTHER, cgnat: false });

        wan.ip = "100.64.0.7";
        wan.writtenAt = new Date(Date.now() + 1_000);
        const fresh = await refreshInboundReach({ publicIp: OTHER, outside: null, hairpin: false });
        expect(fresh).toMatchObject({ cgnat: true, certain: true, reason: "router-wan" });
    });

    it("keeps the last verdict when no address was measured", async () => {
        await refreshInboundReach({ publicIp: FIBRE, outside: "up", hairpin: false });
        const before = settings.get(INBOUND_KEY);
        expect(
            await refreshInboundReach({ publicIp: null, outside: null, hairpin: false })
        ).toMatchObject({
            publicIp: FIBRE
        });
        expect(settings.get(INBOUND_KEY)).toBe(before);
    });
});
