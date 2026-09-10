/**
 * Publishing a domain's records through Cloudflare: the plan, and carrying it
 * out. The rules pinned are the ones that protect mail that already works -
 * an existing SPF is added to rather than replaced, an existing DMARC is kept,
 * an MX pointing elsewhere is left unless replacing it is asked for - and that
 * nothing is reported as done that was not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ZONE = [
    "$ORIGIN example.com.",
    "@ IN MX 10 mail.example.com.",
    '@ IN TXT "v=spf1 mx -all"',
    '202609e._domainkey IN TXT "v=DKIM1; k=ed25519; p=MCowBQYDK2VwAyEA"',
    '_dmarc IN TXT "v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.com"',
    "_25._tcp.mail IN TLSA 3 1 1 abcdef"
].join("\n");

const zoneRecords: Record<string, { id: string; type: string; name: string; content: string }[]> = {};
const created: unknown[] = [];
const updated: { id: string; record: unknown }[] = [];
let relayInclude: string | null = null;
let failCreate = false;

vi.mock("@polaris/db", () => ({ prisma: { mailServer: { update: vi.fn(async () => undefined) } } }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail-server/relay", () => ({ relaySpfInclude: () => relayInclude }));
vi.mock("@/lib/mail-server/access", () => ({ MailServerAccessError: class extends Error {} }));
vi.mock("@/lib/mail-server/operations", () => ({
    listDomains: vi.fn(async () => [{ id: "d1", name: "example.com", enabled: true, catchAll: null, primary: true, zoneFile: ZONE }])
}));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: vi.fn(async () => "token") }));
vi.mock("@/lib/integrations/cloudflare-api", () => ({
    resolveZoneForHostname: vi.fn(async () => ({ id: "zone-1", name: "example.com" })),
    listZoneRecords: vi.fn(async (_token: string, _zone: string, type: string, name: string) => zoneRecords[`${type} ${name}`] ?? []),
    createZoneRecord: vi.fn(async (_token: string, _zone: string, record: unknown) => {
        if (failCreate) throw new Error("Cloudflare refused it");
        created.push(record);
    }),
    updateZoneRecord: vi.fn(async (_token: string, _zone: string, id: string, record: unknown) => {
        updated.push({ id, record });
    })
}));

const dns = await import("@/lib/mail-server/dns");
const server = { id: "s1", orgId: null } as never;

beforeEach(() => {
    for (const key of Object.keys(zoneRecords)) delete zoneRecords[key];
    created.length = 0;
    updated.length = 0;
    relayInclude = null;
    failCreate = false;
    zoneRecords["TXT example.com"] = [{ id: "spf", type: "TXT", name: "example.com", content: "v=spf1 include:_spf.google.com ~all" }];
    zoneRecords["MX example.com"] = [{ id: "mx", type: "MX", name: "example.com", content: "aspmx.l.google.com" }];
    zoneRecords["TXT _dmarc.example.com"] = [{ id: "dmarc", type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=none" }];
});

describe("the plan", () => {
    it("adds to an existing SPF, keeps an existing DMARC, and leaves another MX alone", async () => {
        const plan = await dns.planDns(server, "d1");
        const by = (purpose: string) => plan.records.find((entry) => entry.record.purpose === purpose);
        expect(by("spf")).toMatchObject({ action: "update", value: "v=spf1 mx include:_spf.google.com ~all" });
        expect(by("dmarc")).toMatchObject({ action: "unchanged" });
        expect(by("mx")).toMatchObject({ action: "conflict", existing: ["aspmx.l.google.com"] });
        expect(by("dkim")).toMatchObject({ action: "create" });
        expect(by("tlsa")).toMatchObject({ action: "skip" });
    });

    it("puts the relay's provider in the SPF when mail goes out through one", async () => {
        relayInclude = "include:amazonses.com";
        const plan = await dns.planDns(server, "d1");
        expect(plan.records.find((entry) => entry.record.purpose === "spf")?.value).toBe(
            // The engine's SPF with the relay merged in, then merged into the
            // record already published: what is missing goes in front.
            "v=spf1 include:amazonses.com mx include:_spf.google.com ~all"
        );
    });
});

describe("applying it", () => {
    it("creates and updates what the plan says, and leaves a conflict alone", async () => {
        const results = await dns.applyDns("actor", server, "d1", false);
        expect(results.find((entry) => entry.type === "MX")?.outcome).toBe("left");
        expect(updated.map((entry) => entry.id)).toEqual(["spf"]);
        expect(created).toHaveLength(1);
        expect(results.find((entry) => entry.name.includes("_domainkey"))?.outcome).toBe("created");
    });

    it("replaces a conflict only when asked", async () => {
        await dns.applyDns("actor", server, "d1", true);
        expect(updated.map((entry) => entry.id).sort()).toEqual(["mx", "spf"]);
    });

    it("reports a refusal as failed rather than done", async () => {
        failCreate = true;
        const results = await dns.applyDns("actor", server, "d1", false);
        expect(results.find((entry) => entry.name.includes("_domainkey"))).toMatchObject({ outcome: "failed" });
    });
});

describe("what the resolvers answered", () => {
    it("reads each record type the way the zone writes it", async () => {
        const resolver = {
            resolveMx: async () => [{ exchange: "mail.example.com", priority: 10 }],
            resolveTxt: async () => [["v=DKIM1; k=ed25519; ", "p=abc"]],
            resolveSrv: async () => [{ priority: 0, weight: 1, port: 993, name: "mail.example.com" }],
            resolveCaa: async () => [{ critical: 0, issue: "letsencrypt.org" }]
        } as never;
        const record = (type: string) => ({ name: "example.com", type, ttl: null, value: "", priority: null });
        expect(await dns.publishedValues(resolver, record("MX"))).toEqual(["mail.example.com"]);
        expect(await dns.publishedValues(resolver, record("TXT"))).toEqual(["v=DKIM1; k=ed25519; p=abc"]);
        expect(await dns.publishedValues(resolver, record("SRV"))).toEqual(["0 1 993 mail.example.com"]);
        expect(await dns.publishedValues(resolver, record("CAA"))).toEqual(["0 issue letsencrypt.org"]);
        expect(await dns.publishedValues(resolver, record("TLSA"))).toBeNull();
    });

    it("reads no such name as nothing published, and anything else as no answer", async () => {
        const missing = { resolveMx: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })) } as never;
        const down = { resolveMx: async () => Promise.reject(Object.assign(new Error("x"), { code: "ETIMEOUT" })) } as never;
        const record = { name: "example.com", type: "MX", ttl: null, value: "", priority: null };
        expect(await dns.publishedValues(missing, record)).toEqual([]);
        await expect(dns.publishedValues(down, record)).rejects.toThrow();
    });
});
