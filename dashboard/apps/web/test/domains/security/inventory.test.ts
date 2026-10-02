/**
 * The inventory of known domains, read for one domain: only the rows at or
 * under it are asked for, and a hostname under a deeper known domain stays
 * filed there. The database and the DNS host are fakes.
 */

import { describe, expect, it, vi } from "vitest";

const ZONE_ID = "b".repeat(32);
const ownerFind = vi.fn(async () => [
    { id: "d1", domain: "example.com", userId: "user-1", orgId: null, dnsToken: null },
    { id: "d2", domain: "shop.example.com", userId: "user-1", orgId: null, dnsToken: null }
]);
const hostFind = vi.fn(async () => [
    { hostname: "app.example.com", applicationId: "app-1", certResolver: "le" },
    { hostname: "www.shop.example.com", applicationId: "app-2", certResolver: "le" }
]);

vi.mock("@polaris/db", () => ({
    prisma: {
        ownerDomain: { findMany: ownerFind },
        mailServer: { findMany: vi.fn(async () => []) },
        domain: { findMany: hostFind }
    }
}));
vi.mock("@/lib/domain-zones", () => ({
    getDomainZones: async () => ({ baseDomain: "polaris.example.net" })
}));
vi.mock("@/lib/dns/zone-records", () => ({
    editableZones: async () => [
        { id: ZONE_ID, name: "example.com" },
        { id: "c".repeat(32), name: "example.org" }
    ]
}));
vi.mock("@/lib/mail-server/dns", () => ({ storedDns: () => null }));
vi.mock("@/lib/dns/public-resolver", () => ({
    publicResolver: () => ({ resolveSoa: async () => null })
}));

const { knownDomain } = await import("@/lib/domain-security/inventory");

describe("one known domain", () => {
    it("reads only the rows at or under it", async () => {
        const entry = await knownDomain("Example.com");
        const near = [
            { domain: { equals: "example.com", mode: "insensitive" } },
            { domain: { endsWith: ".example.com", mode: "insensitive" } }
        ];
        expect(ownerFind).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ OR: near }) })
        );
        expect(hostFind).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [
                        { hostname: { equals: "example.com", mode: "insensitive" } },
                        { hostname: { endsWith: ".example.com", mode: "insensitive" } }
                    ]
                })
            })
        );
        expect(entry).toMatchObject({
            domain: "example.com",
            ownerDomain: { id: "d1" },
            zone: { id: ZONE_ID }
        });
        expect(entry?.hostnames.map((host) => host.hostname)).toEqual(["app.example.com"]);
    });

    it("answers null for a domain Polaris has no reason to know", async () => {
        expect(await knownDomain("example.org.invalid")).toBeNull();
    });
});
