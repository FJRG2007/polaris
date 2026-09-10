/**
 * Serving a domain through Cloudflare's proxy, and emptying its cache.
 *
 * What is guarded is that turning the proxy on changes nothing about where a
 * name points - only `proxied` - that a name answered by a wildcard gets a
 * record of its own instead of the wildcard being proxied for every name under
 * it, that a zone on Flexible SSL is refused before it can loop, that the
 * purge after a deploy never fails the deploy, and that the operator's token is
 * only used on a name the caller has standing over.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    loadCloudflareToken: vi.fn(),
    resolveZoneForHostname: vi.fn(),
    findAddressRecords: vi.fn(),
    setRecordProxied: vi.fn(),
    createAddressRecord: vi.fn(),
    zoneSslMode: vi.fn(),
    purgeCache: vi.fn(),
    domainFindFirst: vi.fn(),
    domainFindMany: vi.fn(),
    domainUpdate: vi.fn(),
    dashboardHosts: vi.fn(),
    deployZoneHosts: vi.fn(),
    instanceTokenAllowed: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        domain: {
            findFirst: mocks.domainFindFirst,
            findMany: mocks.domainFindMany,
            update: mocks.domainUpdate
        }
    }
}));
vi.mock("../../src/lib/integrations/cloudflare-account-service", () => ({
    loadCloudflareToken: mocks.loadCloudflareToken
}));
vi.mock("../../src/lib/integrations/cloudflare-api", () => ({
    resolveZoneForHostname: mocks.resolveZoneForHostname,
    findAddressRecords: mocks.findAddressRecords,
    setRecordProxied: mocks.setRecordProxied,
    createAddressRecord: mocks.createAddressRecord,
    zoneSslMode: mocks.zoneSslMode,
    purgeCache: mocks.purgeCache
}));

vi.mock("../../src/lib/domain-edge", () => ({
    dashboardHosts: mocks.dashboardHosts,
    publicHostname: (value: string | undefined) =>
        value ? value.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null
}));
vi.mock("../../src/lib/domain-zones", () => ({ deployZoneHosts: mocks.deployZoneHosts }));
vi.mock("../../src/lib/dns/zone-records", () => ({
    instanceTokenAllowed: mocks.instanceTokenAllowed
}));

const cdn = await import("../../src/lib/cdn");

const CALLER = { ownerId: "owner", orgId: null, actorId: "owner", isAdmin: false };

function standing(): void {
    mocks.dashboardHosts.mockResolvedValue(["polaris.example.com"]);
    mocks.deployZoneHosts.mockResolvedValue([]);
    mocks.instanceTokenAllowed.mockResolvedValue(true);
}

const DOMAIN = {
    id: "d1",
    hostname: "app.example.com",
    cdn: false,
    enabled: true,
    applicationId: "a1"
};

describe("setDomainCdn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadCloudflareToken.mockResolvedValue("cf-token");
        mocks.resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "example.com" });
        mocks.domainFindFirst.mockResolvedValue(DOMAIN);
        mocks.zoneSslMode.mockResolvedValue("strict");
        standing();
    });

    it("sets only proxied on the name's own record", async () => {
        mocks.findAddressRecords.mockResolvedValue([
            {
                id: "r1",
                type: "A",
                name: "app.example.com",
                content: "51.15.20.30",
                proxied: false,
                ttl: 300
            }
        ]);
        await cdn.setDomainCdn("d1", CALLER, true);
        expect(mocks.setRecordProxied).toHaveBeenCalledWith("cf-token", "zone-1", "r1", true);
        expect(mocks.createAddressRecord).not.toHaveBeenCalled();
        expect(mocks.domainUpdate).toHaveBeenCalledWith({
            where: { id: "d1" },
            data: { cdn: true }
        });
    });

    it("gives a wildcard-covered name a record of its own with the wildcard's address", async () => {
        mocks.findAddressRecords.mockImplementation(
            async (_token: string, _zone: string, name: string) =>
                name === "*.example.com"
                    ? [
                          {
                              id: "w1",
                              type: "A",
                              name,
                              content: "51.15.20.30",
                              proxied: false,
                              ttl: 1
                          }
                      ]
                    : []
        );
        await cdn.setDomainCdn("d1", CALLER, true);
        expect(mocks.createAddressRecord).toHaveBeenCalledWith("cf-token", "zone-1", {
            type: "A",
            name: "app.example.com",
            content: "51.15.20.30",
            proxied: true
        });
        expect(mocks.setRecordProxied).not.toHaveBeenCalled();
    });

    it("refuses a zone on Flexible SSL, which would loop on the edge's redirect", async () => {
        mocks.zoneSslMode.mockResolvedValue("flexible");
        await expect(cdn.setDomainCdn("d1", CALLER, true)).rejects.toThrow(/Full \(strict\)/);
        expect(mocks.domainUpdate).not.toHaveBeenCalled();
    });

    it("says the domain has to be on Cloudflare when its zone is not", async () => {
        mocks.resolveZoneForHostname.mockRejectedValue(new Error("not on a domain"));
        await expect(cdn.setDomainCdn("d1", CALLER, true)).rejects.toThrow(/DNS on Cloudflare/);
    });

    it("leaves a tunnel's record proxied when it is turned off", async () => {
        mocks.findAddressRecords.mockResolvedValue([
            {
                id: "t1",
                type: "CNAME",
                name: "app.example.com",
                content: "abc.cfargotunnel.com",
                proxied: true,
                ttl: 1
            },
            {
                id: "r2",
                type: "AAAA",
                name: "app.example.com",
                content: "2001:db8::1",
                proxied: true,
                ttl: 1
            }
        ]);
        await cdn.setDomainCdn("d1", CALLER, false);
        expect(mocks.setRecordProxied).toHaveBeenCalledTimes(1);
        expect(mocks.setRecordProxied).toHaveBeenCalledWith("cf-token", "zone-1", "r2", false);
    });
});

describe("purging", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        standing();
        mocks.loadCloudflareToken.mockResolvedValue("cf-token");
        mocks.resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "example.com" });
    });

    it("empties a prefix under the hostname when one is given", async () => {
        mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, cdn: true });
        await cdn.purgeDomainCache("d1", CALLER, "assets/");
        expect(mocks.purgeCache).toHaveBeenCalledWith("cf-token", "zone-1", {
            prefixes: ["app.example.com/assets/"]
        });
    });

    it("refuses a domain that is not served through Cloudflare", async () => {
        mocks.domainFindFirst.mockResolvedValue(DOMAIN);
        await expect(cdn.purgeDomainCache("d1", CALLER)).rejects.toThrow(
            /not served through Cloudflare/
        );
    });

    it("purges every proxied domain of a service after a release, in one call per zone", async () => {
        mocks.domainFindMany.mockResolvedValue([
            { hostname: "app.example.com" },
            { hostname: "www.example.com" }
        ]);
        await cdn.purgeAfterPromotion("a1");
        expect(mocks.purgeCache).toHaveBeenCalledWith("cf-token", "zone-1", {
            hosts: ["app.example.com", "www.example.com"]
        });
    });

    it("never throws after a release, whatever Cloudflare says", async () => {
        mocks.domainFindMany.mockResolvedValue([{ hostname: "app.example.com" }]);
        mocks.purgeCache.mockRejectedValue(new Error("Authentication error"));
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(cdn.purgeAfterPromotion("a1")).resolves.toBeUndefined();
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });
});

describe("whose name it is", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadCloudflareToken.mockResolvedValue("cf-token");
        mocks.resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "example.com" });
        mocks.zoneSslMode.mockResolvedValue("strict");
        mocks.findAddressRecords.mockResolvedValue([
            {
                id: "r1",
                type: "A",
                name: "mail.example.com",
                content: "51.15.20.30",
                proxied: false,
                ttl: 300
            }
        ]);
        mocks.dashboardHosts.mockResolvedValue(["polaris.example.com"]);
        mocks.deployZoneHosts.mockResolvedValue(["plr.example.com"]);
        mocks.instanceTokenAllowed.mockResolvedValue(false);
    });

    it("refuses a typed name in a zone the caller has not proven, before touching Cloudflare", async () => {
        mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, hostname: "mail.example.com" });
        await expect(cdn.setDomainCdn("d1", CALLER, true)).rejects.toThrow(
            /Add its domain under Domains/
        );
        await expect(cdn.setDomainCdn("d1", CALLER, false)).rejects.toThrow(
            /Add its domain under Domains/
        );
        expect(mocks.loadCloudflareToken).not.toHaveBeenCalled();
        expect(mocks.setRecordProxied).not.toHaveBeenCalled();
        expect(mocks.domainUpdate).not.toHaveBeenCalled();
    });

    it("refuses the manual purge the same way", async () => {
        mocks.domainFindFirst.mockResolvedValue({
            ...DOMAIN,
            hostname: "mail.example.com",
            cdn: true
        });
        await expect(cdn.purgeDomainCache("d1", CALLER)).rejects.toThrow(
            /Add its domain under Domains/
        );
        expect(mocks.purgeCache).not.toHaveBeenCalled();
    });

    it("lets a name Polaris minted in a deploy zone through without a proven domain", async () => {
        mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, hostname: "shop.plr.example.com" });
        await cdn.setDomainCdn("d1", CALLER, true);
        expect(mocks.instanceTokenAllowed).not.toHaveBeenCalled();
        expect(mocks.domainUpdate).toHaveBeenCalledWith({
            where: { id: "d1" },
            data: { cdn: true }
        });
    });

    it("asks about the project's organization and the person asking", async () => {
        mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, hostname: "shop.acme.com" });
        mocks.instanceTokenAllowed.mockResolvedValue(true);
        await cdn.setDomainCdn(
            "d1",
            { ownerId: "owner", orgId: "org-1", actorId: "member", isAdmin: false },
            true
        );
        expect(mocks.instanceTokenAllowed).toHaveBeenCalledWith("shop.acme.com", {
            isAdmin: false,
            owners: [
                { kind: "org", id: "org-1" },
                { kind: "user", id: "member" }
            ]
        });
    });

    it("never changes the dashboard's own name, even for an administrator", async () => {
        mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, hostname: "polaris.example.com" });
        await expect(cdn.setDomainCdn("d1", { ...CALLER, isAdmin: true }, false)).rejects.toThrow(
            /own address/
        );
        expect(mocks.setRecordProxied).not.toHaveBeenCalled();
    });
});
