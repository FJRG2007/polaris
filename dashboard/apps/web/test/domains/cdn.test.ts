/**
 * Serving a domain through Cloudflare's proxy, and emptying its cache.
 *
 * What is guarded is that turning the proxy on changes nothing about where a
 * name points - only `proxied` - that a name answered by a wildcard gets a
 * record of its own instead of the wildcard being proxied for every name under
 * it, that a zone on Flexible SSL is refused before it can loop, and that the
 * purge after a deploy never fails the deploy.
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
    domainUpdate: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        domain: { findFirst: mocks.domainFindFirst, findMany: mocks.domainFindMany, update: mocks.domainUpdate }
    }
}));
vi.mock("../../src/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: mocks.loadCloudflareToken }));
vi.mock("../../src/lib/integrations/cloudflare-api", () => ({
    resolveZoneForHostname: mocks.resolveZoneForHostname,
    findAddressRecords: mocks.findAddressRecords,
    setRecordProxied: mocks.setRecordProxied,
    createAddressRecord: mocks.createAddressRecord,
    zoneSslMode: mocks.zoneSslMode,
    purgeCache: mocks.purgeCache
}));

const cdn = await import("../../src/lib/cdn");

const DOMAIN = { id: "d1", hostname: "app.example.com", cdn: false, enabled: true, applicationId: "a1" };

describe("setDomainCdn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadCloudflareToken.mockResolvedValue("cf-token");
        mocks.resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "example.com" });
        mocks.domainFindFirst.mockResolvedValue(DOMAIN);
        mocks.zoneSslMode.mockResolvedValue("strict");
    });

    it("sets only proxied on the name's own record", async () => {
        mocks.findAddressRecords.mockResolvedValue([
            { id: "r1", type: "A", name: "app.example.com", content: "51.15.20.30", proxied: false, ttl: 300 }
        ]);
        await cdn.setDomainCdn("d1", "owner", true);
        expect(mocks.setRecordProxied).toHaveBeenCalledWith("cf-token", "zone-1", "r1", true);
        expect(mocks.createAddressRecord).not.toHaveBeenCalled();
        expect(mocks.domainUpdate).toHaveBeenCalledWith({ where: { id: "d1" }, data: { cdn: true } });
    });

    it("gives a wildcard-covered name a record of its own with the wildcard's address", async () => {
        mocks.findAddressRecords.mockImplementation(async (_token: string, _zone: string, name: string) =>
            name === "*.example.com"
                ? [{ id: "w1", type: "A", name, content: "51.15.20.30", proxied: false, ttl: 1 }]
                : []
        );
        await cdn.setDomainCdn("d1", "owner", true);
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
        await expect(cdn.setDomainCdn("d1", "owner", true)).rejects.toThrow(/Full \(strict\)/);
        expect(mocks.domainUpdate).not.toHaveBeenCalled();
    });

    it("says the domain has to be on Cloudflare when its zone is not", async () => {
        mocks.resolveZoneForHostname.mockRejectedValue(new Error("not on a domain"));
        await expect(cdn.setDomainCdn("d1", "owner", true)).rejects.toThrow(/DNS on Cloudflare/);
    });

    it("leaves a tunnel's record proxied when it is turned off", async () => {
        mocks.findAddressRecords.mockResolvedValue([
            { id: "t1", type: "CNAME", name: "app.example.com", content: "abc.cfargotunnel.com", proxied: true, ttl: 1 },
            { id: "r2", type: "AAAA", name: "app.example.com", content: "2001:db8::1", proxied: true, ttl: 1 }
        ]);
        await cdn.setDomainCdn("d1", "owner", false);
        expect(mocks.setRecordProxied).toHaveBeenCalledTimes(1);
        expect(mocks.setRecordProxied).toHaveBeenCalledWith("cf-token", "zone-1", "r2", false);
    });
});

describe("purging", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadCloudflareToken.mockResolvedValue("cf-token");
        mocks.resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "example.com" });
    });

    it("empties a prefix under the hostname when one is given", async () => {
        mocks.domainFindFirst.mockResolvedValue({ ...DOMAIN, cdn: true });
        await cdn.purgeDomainCache("d1", "owner", "assets/");
        expect(mocks.purgeCache).toHaveBeenCalledWith("cf-token", "zone-1", { prefixes: ["app.example.com/assets/"] });
    });

    it("refuses a domain that is not served through Cloudflare", async () => {
        mocks.domainFindFirst.mockResolvedValue(DOMAIN);
        await expect(cdn.purgeDomainCache("d1", "owner")).rejects.toThrow(/not served through Cloudflare/);
    });

    it("purges every proxied domain of a service after a release, in one call per zone", async () => {
        mocks.domainFindMany.mockResolvedValue([{ hostname: "app.example.com" }, { hostname: "www.example.com" }]);
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
