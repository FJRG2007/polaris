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

const { resolve4, loadCloudflareToken, resolveZoneForHostname, findDnsRecords, upsertARecord, pruneDnsRecords } =
    vi.hoisted(() => ({
        resolve4: vi.fn(),
        loadCloudflareToken: vi.fn(),
        resolveZoneForHostname: vi.fn(),
        findDnsRecords: vi.fn(),
        upsertARecord: vi.fn(),
        pruneDnsRecords: vi.fn()
    }));

vi.mock("@polaris/db", () => ({ prisma: { setting: { findUnique: async () => null } } }));
vi.mock("node:dns/promises", () => ({ resolve4 }));
vi.mock("../../src/lib/network-service", () => ({ detectPublicIp: async () => "51.15.20.30" }));
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
        resolve4.mockRejectedValue(new Error("NXDOMAIN"));
        loadCloudflareToken.mockResolvedValue("cf-token");
        resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "fjrg2007.com" });
        findDnsRecords.mockResolvedValue([]);
        upsertARecord.mockResolvedValue("record-1");
        pruneDnsRecords.mockResolvedValue(undefined);
    });

    it("creates the record for a name on the operator's own domain", async () => {
        expect(await provisionHostnameDns("orphion.fjrg2007.com")).toEqual({
            status: "created",
            ip: "51.15.20.30"
        });
        expect(upsertARecord).toHaveBeenCalledWith("cf-token", "zone-1", "orphion.fjrg2007.com", "51.15.20.30");
    });

    it("creates it just the same on a different domain the token reaches", async () => {
        resolveZoneForHostname.mockResolvedValue({ id: "zone-2", name: "orphion.com" });
        expect((await provisionHostnameDns("orphion.com")).status).toBe("created");
        expect(upsertARecord).toHaveBeenCalledWith("cf-token", "zone-2", "orphion.com", "51.15.20.30");
    });

    it("takes the hostname as typed, however it was capitalized or spaced", async () => {
        await provisionHostnameDns("  Orphion.FJRG2007.com  ");
        expect(upsertARecord).toHaveBeenCalledWith("cf-token", "zone-1", "orphion.fjrg2007.com", "51.15.20.30");
    });

    it("asks Cloudflare nothing about a name that already answers here", async () => {
        // A wildcard the operator already created covers it, so there is no record to
        // write and nothing to tell them about.
        resolve4.mockResolvedValue(["51.15.20.30"]);
        expect(await provisionHostnameDns("orphion.fjrg2007.com")).toEqual({
            status: "unchanged",
            ip: "51.15.20.30"
        });
        expect(resolveZoneForHostname).not.toHaveBeenCalled();
    });

    it("leaves an existing record that already points here alone", async () => {
        findDnsRecords.mockResolvedValue([{ id: "record-1", content: "51.15.20.30" }]);
        expect((await provisionHostnameDns("orphion.fjrg2007.com")).status).toBe("unchanged");
        expect(upsertARecord).not.toHaveBeenCalled();
    });

    it("never repoints a name that answers somewhere else, and says where", async () => {
        findDnsRecords.mockResolvedValue([{ id: "record-9", content: "203.0.113.7" }]);
        expect(await provisionHostnameDns("orphion.fjrg2007.com")).toEqual({
            status: "conflict",
            ip: "51.15.20.30",
            content: "203.0.113.7"
        });
        expect(upsertARecord).not.toHaveBeenCalled();
        expect(pruneDnsRecords).not.toHaveBeenCalled();
    });

    it("hands the record back to the operator when no token is connected", async () => {
        loadCloudflareToken.mockResolvedValue(null);
        const result = await provisionHostnameDns("orphion.fjrg2007.com");
        expect(result.status).toBe("manual");
        expect(result.ip).toBe("51.15.20.30");
        expect(result.detail).toContain("Cloudflare");
    });

    it("reports why rather than throwing when the domain is not in the account", async () => {
        resolveZoneForHostname.mockRejectedValue(new Error("orphion.com is not on a domain in this Cloudflare account."));
        const result = await provisionHostnameDns("orphion.com");
        expect(result.status).toBe("manual");
        expect(result.detail).toContain("not on a domain");
    });
});
