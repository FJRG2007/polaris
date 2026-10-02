/**
 * Pointing one custom hostname at this server. This is what lets a service take any
 * name at all - one straight on the operator's own domain, or one on a different
 * domain entirely - without the wildcard record a deploy zone rides on.
 *
 * What is guarded here is restraint: the name may already be a live site, so a record
 * answering somewhere else is reported, never repointed, and a name a wildcard already
 * covers is left untouched without so much as a call to Cloudflare. Everything that
 * cannot be done is a result the panel can explain, never a thrown error - the domain
 * itself was added either way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    resolve4,
    loadCloudflareToken,
    resolveZoneForHostname,
    findDnsRecords,
    upsertARecord,
    pruneDnsRecords,
    findDomain
} = vi.hoisted(() => ({
    findDomain: vi.fn(),
    resolve4: vi.fn(),
    loadCloudflareToken: vi.fn(),
    resolveZoneForHostname: vi.fn(),
    findDnsRecords: vi.fn(),
    upsertARecord: vi.fn(),
    pruneDnsRecords: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: { setting: { findUnique: async () => null }, domain: { findUnique: findDomain } }
}));
vi.mock("node:dns/promises", () => ({ resolve4 }));
vi.mock("../../src/lib/network-service", () => ({ detectPublicIp: async () => "5.6.7.8" }));
vi.mock("../../src/lib/domain-service", () => ({ setDomainConfig: vi.fn() }));
vi.mock("../../src/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken }));
vi.mock("../../src/lib/integrations/cloudflare-api", () => ({
    resolveZoneForHostname,
    findDnsRecords,
    upsertARecord,
    pruneDnsRecords
}));

const { provisionHostnameDns } = await import("../../src/lib/domain-dns");

describe("provisionHostnameDns", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findDomain.mockResolvedValue(null);
        resolve4.mockRejectedValue(new Error("NXDOMAIN"));
        loadCloudflareToken.mockResolvedValue("cf-token");
        resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "example.com" });
        findDnsRecords.mockResolvedValue([]);
        upsertARecord.mockResolvedValue("record-1");
        pruneDnsRecords.mockResolvedValue(undefined);
    });

    it("creates the record for a name on the operator's own domain", async () => {
        expect(await provisionHostnameDns("storefront.example.com")).toEqual({
            status: "created",
            ip: "5.6.7.8"
        });
        expect(upsertARecord).toHaveBeenCalledWith(
            "cf-token",
            "zone-1",
            "storefront.example.com",
            "5.6.7.8"
        );
    });

    it("creates it just the same on a different domain the token reaches", async () => {
        resolveZoneForHostname.mockResolvedValue({ id: "zone-2", name: "example.org" });
        expect((await provisionHostnameDns("example.org")).status).toBe("created");
        expect(upsertARecord).toHaveBeenCalledWith(
            "cf-token",
            "zone-2",
            "example.org",
            "5.6.7.8"
        );
    });

    it("takes the hostname as typed, however it was capitalized or spaced", async () => {
        await provisionHostnameDns("  Storefront.EXAMPLE.com  ");
        expect(upsertARecord).toHaveBeenCalledWith(
            "cf-token",
            "zone-1",
            "storefront.example.com",
            "5.6.7.8"
        );
    });

    it("asks Cloudflare nothing about a name that already answers here", async () => {
        // A wildcard the operator already created covers it, so there is no record to
        // write and nothing to tell them about.
        resolve4.mockResolvedValue(["5.6.7.8"]);
        expect(await provisionHostnameDns("storefront.example.com")).toEqual({
            status: "unchanged",
            ip: "5.6.7.8"
        });
        expect(resolveZoneForHostname).not.toHaveBeenCalled();
    });

    it("leaves an existing record that already points here alone", async () => {
        findDnsRecords.mockResolvedValue([{ id: "record-1", content: "5.6.7.8" }]);
        expect((await provisionHostnameDns("storefront.example.com")).status).toBe("unchanged");
        expect(upsertARecord).not.toHaveBeenCalled();
    });

    it("never repoints a name that answers somewhere else, and says where", async () => {
        findDnsRecords.mockResolvedValue([{ id: "record-9", content: "203.0.113.7" }]);
        expect(await provisionHostnameDns("storefront.example.com")).toEqual({
            status: "conflict",
            ip: "5.6.7.8",
            content: "203.0.113.7"
        });
        expect(upsertARecord).not.toHaveBeenCalled();
        expect(pruneDnsRecords).not.toHaveBeenCalled();
    });

    it("hands the record back to the operator when no token is connected", async () => {
        loadCloudflareToken.mockResolvedValue(null);
        const result = await provisionHostnameDns("storefront.example.com");
        expect(result.status).toBe("manual");
        expect(result.ip).toBe("5.6.7.8");
        expect(result.detail).toContain("Cloudflare");
    });

    it("reports why rather than throwing when the domain is not in the account", async () => {
        resolveZoneForHostname.mockRejectedValue(
            new Error("example.org is not on a domain in this Cloudflare account.")
        );
        const result = await provisionHostnameDns("example.org");
        expect(result.status).toBe("manual");
        expect(result.detail).toContain("not on a domain");
    });

    describe("for a service on another server", () => {
        const onServer = (address: string, servedBy = "server") => ({
            servedBy,
            application: { target: { kind: "host", host: { name: "aws-1", address } } }
        });

        it("points the name at that server, never at this one", async () => {
            // The control plane may be a home box that loses power; a name served by a
            // cloud server must resolve to the cloud server.
            findDomain.mockResolvedValue(onServer("54.0.0.10"));

            expect(await provisionHostnameDns("api.example.com")).toEqual({
                status: "created",
                ip: "54.0.0.10"
            });
            expect(upsertARecord).toHaveBeenCalledWith(
                "cf-token",
                "zone-1",
                "api.example.com",
                "54.0.0.10"
            );
        });

        it("hands the record back when that server has no public address", async () => {
            findDomain.mockResolvedValue(onServer("10.0.1.5"));

            const result = await provisionHostnameDns("api.example.com");

            expect(result).toMatchObject({ status: "manual", ip: null });
            expect(upsertARecord).not.toHaveBeenCalled();
        });

        it("points at this server only when the operator chose to route it through Polaris", async () => {
            findDomain.mockResolvedValue(onServer("54.0.0.10", "polaris"));

            expect((await provisionHostnameDns("api.example.com")).ip).toBe("5.6.7.8");
        });
    });
});
