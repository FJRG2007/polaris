/**
 * How often a reputation provider is actually asked.
 *
 * The firewall's sweep runs every thirty seconds over the same few megabytes of
 * access log. It skipped the addresses it had already banned - and nothing else,
 * because an address that came back clean was never written down anywhere. So the
 * same ordinary visitors were looked up twice a minute, twenty-five per pass, for
 * as long as they stayed in the log window: tens of thousands of paid lookups a
 * day, every one of them a question that had already been answered.
 *
 * These are the assertions that keep it fixed: a second pass over the same traffic
 * asks nobody, a flagged address is still banned from what was remembered, and a
 * change to the deny rules is a new question rather than a cached answer to an old
 * one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface BanRow {
    ip: string;
    reason: string;
    source: string;
    note: string | null;
    until: Date | null;
    offences: number;
}

interface ReputationRow {
    subject: string;
    provider: string;
    allow: boolean;
    reason: string | null;
    rules: string;
    checkedAt: Date;
}

interface SubjectKey {
    subject: string;
    provider: string;
}

let bans: BanRow[] = [];
let verdicts: ReputationRow[] = [];
let deny = ["FRAUD"];
/** Every address the provider was asked about, in order. The whole point. */
let asked: string[] = [];

process.env.POLARIS_EDGE_INTEL_FILE = "";

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => "test-key",
    getIntegrationState: async (slug: string) =>
        slug === "dymo" ? { enabled: true, config: null } : null
}));
vi.mock("@/lib/address-accounts", () => ({
    addressesSignedIn: async () => new Set<string>(),
    addressesTrusted: async () => new Set<string>()
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/integrations/registry", () => ({
    readDymoConfig: () => ({ verifyAccessIp: true, deny })
}));
vi.mock("@/lib/integrations/dymo", () => ({
    verifyIp: async (_key: string, ip: string) => {
        asked.push(ip);
        return ip === "9.9.9.9"
            ? { allow: false, reasons: ["proxy"] }
            : { allow: true, reasons: [] };
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        wafBan: {
            findUnique: async ({ where }: { where: { ip: string } }) =>
                bans.find((ban) => ban.ip === where.ip) ?? null,
            findMany: async ({ where }: { where?: { ip?: { in: string[] } } } = {}) =>
                where?.ip?.in ? bans.filter((ban) => where.ip?.in.includes(ban.ip)) : bans,
            upsert: async ({ where, create }: { where: { ip: string }; create: BanRow }) => {
                bans = [...bans.filter((ban) => ban.ip !== where.ip), { ...create, offences: 1 }];
                return create;
            },
            deleteMany: async () => ({ count: 0 })
        },
        subjectReputation: {
            findUnique: async ({ where }: { where: { kind_subject_provider: SubjectKey } }) =>
                verdicts.find(
                    (row) =>
                        row.subject === where.kind_subject_provider.subject &&
                        row.provider === where.kind_subject_provider.provider
                ) ?? null,
            upsert: async ({
                where,
                create
            }: {
                where: { kind_subject_provider: SubjectKey };
                create: ReputationRow;
            }) => {
                verdicts = [
                    ...verdicts.filter(
                        (row) =>
                            row.subject !== where.kind_subject_provider.subject ||
                            row.provider !== where.kind_subject_provider.provider
                    ),
                    create
                ];
                return create;
            }
        },
        wafIpFeed: { findUnique: async () => null, upsert: async () => undefined },
        user: { findMany: async () => [] }
    }
}));

const { checkReputation } = await import("@/lib/waf-intel-service");
const { resetLookupBudget } = await import("@/lib/reputation-budget");

const TRAFFIC = ["8.8.8.8", "1.1.1.1", "9.9.9.9"];

beforeEach(() => {
    bans = [];
    verdicts = [];
    asked = [];
    deny = ["FRAUD"];
    resetLookupBudget();
});

describe("asking a provider about the addresses in the log", () => {
    it("asks about each of them once", async () => {
        await checkReputation(TRAFFIC);
        expect(asked).toEqual(TRAFFIC);
    });

    it("asks nobody on the next pass over the same traffic", async () => {
        await checkReputation(TRAFFIC);
        asked = [];
        await checkReputation(TRAFFIC);
        expect(asked).toEqual([]);
    });

    it("still bans the one that was flagged, from what it remembered", async () => {
        await checkReputation(TRAFFIC);
        bans = [];
        asked = [];
        await checkReputation(TRAFFIC);
        expect(asked).toEqual([]);
        expect(bans.map((ban) => ban.ip)).toEqual(["9.9.9.9"]);
    });

    it("asks again when the operator changes what counts as bad", async () => {
        await checkReputation(TRAFFIC);
        asked = [];
        deny = ["FRAUD", "VPN"];
        await checkReputation(TRAFFIC);
        // The one already banned is not asked about again under any rules - it is
        // blocked, and the answer would change nothing.
        expect(asked).toEqual(["8.8.8.8", "1.1.1.1"]);
    });

    it("leaves addresses nobody outside can reach alone", async () => {
        await checkReputation([
            "192.168.50.5",
            "127.0.0.1",
            "10.0.0.3",
            "172.16.0.9",
            "100.64.0.7",
            "fd7a:115c::1",
            "fe80::1"
        ]);
        expect(asked).toEqual([]);
    });

    it("stops at its share of the budget however many strangers are in the log", async () => {
        const strangers = Array.from({ length: 200 }, (_, at) => `8.8.${at}.1`);
        for (let pass = 0; pass < 10; pass += 1) await checkReputation(strangers);
        expect(asked).toHaveLength(15);
    });

    it("does not remember an outage as a verdict", async () => {
        const dymo = await import("@/lib/integrations/dymo");
        const failing = vi
            .spyOn(dymo, "verifyIp")
            .mockRejectedValue(new Error("the provider is down"));
        await checkReputation(["8.8.8.8"]);
        failing.mockRestore();
        await checkReputation(["8.8.8.8"]);
        expect(asked).toEqual(["8.8.8.8"]);
    });
});
