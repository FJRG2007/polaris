/**
 * What a zone has to prove before Polaris hands out URLs on it. The app domain is
 * built into every link Polaris sends - invites, notification links, the dashboard's
 * own - so the guided setup only records the intention to move it; the resolver check
 * is what carries it out, and only when the wildcard is answering with this server's
 * address. The other half is that the check runs at all: a layout nobody ever proved
 * keeps every share link on a tunnel it does not need.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, resolve4, setDomainConfig } = vi.hoisted(() => ({
    store: new Map<string, string>(),
    resolve4: vi.fn(),
    setDomainConfig: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) => {
                const value = store.get(where.key);
                return value === undefined ? null : { value };
            },
            upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
                store.set(where.key, create.value);
            },
            deleteMany: async ({ where }: { where: { key: string } }) => {
                store.delete(where.key);
            }
        }
    }
}));
vi.mock("node:dns/promises", () => ({ resolve4 }));
vi.mock("../../src/lib/network-service", () => ({ detectPublicIp: async () => "51.15.20.30" }));
vi.mock("../../src/lib/domain-service", () => ({ setDomainConfig }));
vi.mock("../../src/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: async () => null }));

const { checkZoneDns } = await import("../../src/lib/domain-dns");
const { saveDomainZones, setDashboardZoneIntent, zoneDnsVerified, zoneReachable } = await import(
    "../../src/lib/domain-zones"
);

/**
 * The reachability probe. Any answer counts - a zone host is not a site Polaris
 * serves, so the edge's own 404 is proof enough that packets arrive - which is why
 * "not reachable" is a refused connection, not a status code.
 */
function serving(reachable: boolean): void {
    vi.stubGlobal("fetch", async () => {
        if (!reachable) throw new Error("ECONNREFUSED");
        return new Response("not found", { status: 404 });
    });
}

const LAYOUT = {
    baseDomain: "example.com",
    zones: [
        { label: "polaris", scope: "polaris", primary: true },
        { label: "plr", scope: "deploy", primary: true }
    ]
};

describe("checkZoneDns", () => {
    beforeEach(async () => {
        store.clear();
        resolve4.mockReset();
        setDomainConfig.mockReset();
        serving(true);
        await saveDomainZones(LAYOUT);
        await setDashboardZoneIntent(true);
    });

    it("still mints hostnames when nothing answers, but hands out no links", async () => {
        resolve4.mockResolvedValue(["51.15.20.30"]);
        serving(false);
        await checkZoneDns();
        // The DNS is right, so the layout is usable - a router that will not loop a
        // request back to its own public address must not stop the domain working.
        expect(await zoneDnsVerified()).toBe(true);
        // But nothing has been seen answering, so the dashboard stays where it is and
        // the fallback tunnel keeps covering the links.
        expect(await zoneReachable()).toBe(false);
        expect(setDomainConfig).not.toHaveBeenCalled();
    });

    it("leaves the dashboard where it is while the zone resolves nowhere", async () => {
        resolve4.mockRejectedValue(new Error("NXDOMAIN"));
        await checkZoneDns();
        expect(await zoneDnsVerified()).toBe(false);
        expect(setDomainConfig).not.toHaveBeenCalled();
    });

    it("does not move it onto a wildcard answering for another machine", async () => {
        resolve4.mockResolvedValue(["203.0.113.9"]);
        await checkZoneDns();
        expect(await zoneDnsVerified()).toBe(false);
        expect(setDomainConfig).not.toHaveBeenCalled();
    });

    it("moves it once every zone answers with this server, and only once", async () => {
        resolve4.mockResolvedValue(["51.15.20.30"]);
        await checkZoneDns();
        expect(await zoneDnsVerified()).toBe(true);
        expect(setDomainConfig).toHaveBeenCalledWith({ appDomain: "polaris.example.com" });

        setDomainConfig.mockClear();
        await checkZoneDns();
        expect(setDomainConfig).not.toHaveBeenCalled();
    });

    it("stays put when the operator did not ask for it", async () => {
        await setDashboardZoneIntent(false);
        resolve4.mockResolvedValue(["51.15.20.30"]);
        await checkZoneDns();
        expect(await zoneDnsVerified()).toBe(true);
        expect(setDomainConfig).not.toHaveBeenCalled();
    });

    it("makes a changed layout earn its proof again", async () => {
        resolve4.mockResolvedValue(["51.15.20.30"]);
        await checkZoneDns();
        await saveDomainZones({ ...LAYOUT, baseDomain: "other.example.com" });
        expect(await zoneDnsVerified()).toBe(false);
    });
});
