/**
 * The domain security service: who may see and fix a domain, the daily pass
 * that tells people about regressions, and the automatic fixes for a domain
 * handed to Polaris. The network and the database are fakes.
 */

import type { Probes } from "@/lib/domain-security/collect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownDomain } from "@/lib/domain-security/inventory";

const ZONE_ID = "a".repeat(32);
const audits = new Map<string, Record<string, unknown>>();
let known: KnownDomain[] = [];
const notified: { userId: string; title: string; href: string | null | undefined }[] = [];
const saved: { scope: unknown; recordId: string | null; draft: { type: string; name: string; content: string } }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        domainSecurityAudit: {
            findUnique: vi.fn(async ({ where }: { where: { domain: string } }) => audits.get(where.domain) ?? null),
            findMany: vi.fn(async () => [...audits.values()]),
            upsert: vi.fn(async ({ where, create, update }: { where: { domain: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
                audits.set(where.domain, { ...(audits.get(where.domain) ?? create), ...update, domain: where.domain });
            }),
            update: vi.fn(async ({ where, data }: { where: { domain: string }; data: Record<string, unknown> }) => {
                audits.set(where.domain, { ...audits.get(where.domain), ...data });
            })
        },
        ownerDomain: { findUnique: vi.fn(async () => ({ dnsToken: "sealed" })) },
        organization: { findUnique: vi.fn(async () => ({ slug: "acme" })) },
        user: { findMany: vi.fn(async () => [{ id: "admin-1" }]) },
        mailDmarcReport: { findMany: vi.fn(async () => []) },
        application: { findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@/lib/domain-security/inventory", () => ({
    knownDomains: vi.fn(async () => known),
    knownDomain: vi.fn(async (name: string) => known.find((entry) => entry.domain === name) ?? null)
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: vi.fn(async (input: { userId: string; title: string; href?: string | null }) => {
        notified.push({ userId: input.userId, title: input.title, href: input.href });
    })
}));
vi.mock("@/lib/notifications/notice-words", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return { wordsFor: async (_: string, namespace: "domainSecurity") => translatorFor("en-US", namespace) };
});
vi.mock("@/lib/tls/managed-certificates", () => ({ openText: () => "owner-token" }));
vi.mock("@/lib/orgs/org-service", () => ({ orgPeopleHolding: vi.fn(async () => ["org-owner"]) }));
vi.mock("@/lib/mail-server/dmarc-report", () => ({ storedReport: vi.fn() }));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: async () => "instance-token" }));
vi.mock("@/lib/integrations/cloudflare-api", () => ({
    CloudflareApiError: class extends Error {},
    resolveZoneForHostname: async () => ({ id: ZONE_ID, name: "example.com" }),
    getZoneDnssec: async () => ({ status: "disabled", ds: null }),
    enableZoneDnssec: vi.fn(async () => ({ status: "pending", ds: null }))
}));
vi.mock("@/lib/dns/zone-records", () => ({
    DnsEditError: class extends Error {},
    zoneRecords: vi.fn(async () => ({ zone: { id: ZONE_ID, name: "example.com" }, within: null, records: [] })),
    saveZoneRecord: vi.fn(async (scope: unknown, recordId: string | null, draft: { type: string; name: string; content: string }) => {
        saved.push({ scope, recordId, draft });
        return {};
    }),
    deleteZoneRecord: vi.fn()
}));

const service = await import("@/lib/domain-security/service");

/** A fake network for a domain that publishes nothing at all. */
function emptyProbes(): Probes {
    const none = async () => {
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    };
    return {
        dns: { resolveMx: none, resolveTxt: none, resolveNs: none, resolveCaa: none, resolve4: none, resolve6: none, resolveCname: none },
        dnssec: async () => ({ present: false, validated: false }),
        axfr: async () => null,
        registration: async () => null,
        web: async () => null,
        mtaStsPolicy: async () => ({ status: "missing" }),
        keyBits: () => null,
        randomLabel: () => "polaris-random"
    };
}

function domain(overrides: Partial<KnownDomain>): KnownDomain {
    return { domain: "example.com", sources: ["owner"], ownerDomain: null, zone: null, mailServers: [], hostnames: [], ...overrides };
}

beforeEach(() => {
    audits.clear();
    notified.length = 0;
    saved.length = 0;
    known = [];
});

describe("who may see a domain", () => {
    it("refuses another owner's domain as if it were not there", async () => {
        known = [domain({ ownerDomain: { id: "d1", userId: "user-1", orgId: null, hasToken: false } })];
        await expect(service.domainSecurityView({ userId: "user-2", isAdmin: false, owner: { kind: "user", id: "user-2" } }, "example.com")).rejects.toMatchObject({
            key: "errors.notFound"
        });
        await expect(service.domainSecurityView({ userId: "user-2", isAdmin: false, owner: null }, "example.com")).rejects.toMatchObject({ key: "errors.notFound" });
        const view = await service.domainSecurityView({ userId: "user-1", isAdmin: false, owner: { kind: "user", id: "user-1" } }, "example.com");
        expect(view).toMatchObject({ domain: "example.com", report: null, canFix: false });
    });

    it("lets the owner fix with their own token, never the instance's", async () => {
        known = [domain({ ownerDomain: { id: "d1", userId: "user-1", orgId: null, hasToken: true }, zone: { id: ZONE_ID, name: "example.com" } })];
        const owner = await service.domainSecurityView({ userId: "user-1", isAdmin: false, owner: { kind: "user", id: "user-1" } }, "example.com");
        expect(owner.canFix).toBe(true);
        const admin = await service.domainSecurityView({ userId: "admin-1", isAdmin: true, owner: null }, "example.com");
        expect(admin.canFix).toBe(true);
    });
});

describe("the daily pass", () => {
    it("audits, stores, and tells the owner about what is wrong", async () => {
        known = [domain({ ownerDomain: { id: "d1", userId: "user-1", orgId: null, hasToken: false } })];
        const result = await service.runDomainSecuritySweep(emptyProbes());
        expect(result).toMatchObject({ audited: 1, told: 1, fixed: 0 });
        expect(audits.get("example.com")?.grade).toBe("exposed");
        expect(notified).toEqual([expect.objectContaining({ userId: "user-1", href: "/account/domains" })]);
        expect(notified[0]!.title).toMatch(/^example\.com: \d+ new security problems$/);
    });

    it("says nothing the second time when nothing got worse", async () => {
        known = [domain({ ownerDomain: { id: "d1", userId: "user-1", orgId: null, hasToken: false } })];
        await service.runDomainSecuritySweep(emptyProbes());
        notified.length = 0;
        // Make the stored audit stale, then run again.
        audits.set("example.com", { ...audits.get("example.com"), checkedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
        await service.runDomainSecuritySweep(emptyProbes());
        expect(notified).toEqual([]);
    });

    it("fixes a dedicated domain on its own and says what it did", async () => {
        known = [domain({ sources: ["cloudflare"], zone: { id: ZONE_ID, name: "example.com" } })];
        audits.set("example.com", { domain: "example.com", dedicated: true, dedicatedBy: "admin-1", dedicatedScope: "instance", checkedAt: null, report: null });
        const result = await service.runDomainSecuritySweep(emptyProbes());
        expect(result.fixed).toBeGreaterThan(0);
        expect(saved.map((entry) => `${entry.draft.type} ${entry.draft.name} ${entry.draft.content}`)).toEqual(
            expect.arrayContaining(["TXT example.com v=spf1 -all", "MX example.com .", "TXT _dmarc.example.com v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"])
        );
        expect(saved.every((entry) => (entry.scope as { kind: string }).kind === "instance")).toBe(true);
        // The records, and signing switched on through the DNS host's API.
        const cloudflare = await import("@/lib/integrations/cloudflare-api");
        expect(cloudflare.enableZoneDnssec).toHaveBeenCalledWith("instance-token", ZONE_ID);
        expect(audits.get("example.com")?.lastAutoFix).toMatchObject({ applied: saved.length + 1, failed: 0 });
        expect(notified.map((entry) => entry.userId)).toEqual(["admin-1"]);
    });

    it("writes a dedicated domain only with the token of whoever dedicated it", async () => {
        const both = { ownerDomain: { id: "d1", userId: "user-1", orgId: null, hasToken: true }, zone: { id: ZONE_ID, name: "example.com" } };
        known = [domain({ sources: ["owner", "cloudflare"], ...both })];
        await service.setDedicated({ userId: "user-1", isAdmin: false, owner: { kind: "user", id: "user-1" } }, "example.com", true);
        expect(audits.get("example.com")).toMatchObject({ dedicated: true, dedicatedBy: "user-1", dedicatedScope: "owner" });
        await service.runDomainSecuritySweep(emptyProbes());
        expect(saved.length).toBeGreaterThan(0);
        expect(saved.every((entry) => (entry.scope as { kind: string }).kind === "owner")).toBe(true);

        saved.length = 0;
        audits.clear();
        await service.setDedicated({ userId: "admin-1", isAdmin: true, owner: null }, "example.com", true);
        expect(audits.get("example.com")).toMatchObject({ dedicatedScope: "instance" });
        await service.runDomainSecuritySweep(emptyProbes());
        expect(saved.length).toBeGreaterThan(0);
        expect(saved.every((entry) => (entry.scope as { kind: string }).kind === "instance")).toBe(true);
    });

    it("fixes nothing on a dedicated domain that does not say whose token to use", async () => {
        known = [domain({ sources: ["cloudflare"], zone: { id: ZONE_ID, name: "example.com" } })];
        audits.set("example.com", { domain: "example.com", dedicated: true, dedicatedBy: "admin-1", dedicatedScope: null, checkedAt: null, report: null });
        const result = await service.runDomainSecuritySweep(emptyProbes());
        expect(result.fixed).toBe(0);
        expect(saved).toEqual([]);
    });
});
