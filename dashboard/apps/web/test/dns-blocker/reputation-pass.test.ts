/**
 * The reputation pass against Dymo answering, refusing one name, and being
 * down: one name it refuses never holds up the rest of the log, Dymo down
 * leaves the names for the next pass, and the screen's flagged list is what
 * the DNS server blocks.
 */

import * as dns from "@/lib/dns-blocker/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state: { cursor: unknown; refused: Set<string>; asked: string[]; log: string } = {
    cursor: null,
    refused: new Set(),
    asked: [],
    log: ""
};

const line = (domain: string) =>
    [
        "2026-10-21 10:00:00",
        "192.168.1.20",
        "phone",
        "3",
        "RESOLVED (1.1.1.1)",
        `${domain}.`,
        "",
        "",
        "RESOLVED",
        "A"
    ].join("\t");

const findMany = vi.fn(async (_args: unknown) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        dnsReputation: {
            findMany: (args: unknown) => findMany(args),
            upsert: async () => ({}),
            deleteMany: async () => ({ count: 0 })
        }
    }
}));
vi.mock("@/lib/dns-blocker/service", () => ({
    readSettings: async () => ({
        ...dns.DEFAULT_DNS_SETTINGS,
        reputation: { ...dns.DEFAULT_DNS_SETTINGS.reputation, fraud: true }
    }),
    readLogCursor: async () => state.cursor,
    saveLogCursor: async (cursor: unknown) => {
        state.cursor = cursor;
    }
}));
vi.mock("@/lib/reputation-budget", () => ({ takeLookup: () => true }));
vi.mock("@/lib/dns-blocker/engine-files", () => ({ writeEngineFiles: async () => false }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => ({ enabled: true }),
    getIntegrationSecret: async () => "key"
}));
vi.mock("@/lib/integrations/dymo", () => ({
    domainReputation: async (_key: string, domain: string) => {
        state.asked.push(domain);
        if (state.refused.has(domain)) throw new Error("refused");
        return { fraud: false, adult: false };
    }
}));
vi.mock("@/lib/dns-blocker/insights", () => ({
    engineTarget: async () => ({
        container: "engine-1",
        ports: {
            readFile: async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(state.log));
                        controller.close();
                    }
                })
        }
    })
}));

const service = await import("@/lib/dns-blocker/reputation-service");

beforeEach(() => {
    state.cursor = null;
    state.refused = new Set();
    state.asked = [];
    findMany.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const log = (...domains: string[]) => domains.map((domain) => `${line(domain)}\n`).join("");

describe("the reputation pass", () => {
    it("passes over one name Dymo refuses and goes on with the rest", async () => {
        state.log = log("bad.example", "a.example", "b.example");
        state.refused.add("bad.example");
        await service.runReputationPass();
        expect(state.asked).toEqual(["bad.example", "a.example", "b.example"]);
        expect(state.cursor).toMatchObject({ offset: Buffer.byteLength(state.log) });
    });

    it("leaves every name for the next pass when Dymo is down", async () => {
        state.log = log("a.example", "b.example", "c.example", "d.example");
        state.refused = new Set(["a.example", "b.example", "c.example", "d.example"]);
        await service.runReputationPass();
        expect(state.asked).toEqual(["a.example", "b.example", "c.example"]);
        expect(state.cursor).toMatchObject({ offset: 0 });
    });

    it("says Dymo failed on a recheck, rather than the budget", async () => {
        state.refused.add("bad.example");
        expect(await service.recheckDomain("bad.example")).toBe("failed");
    });
});

describe("the flagged list", () => {
    it("lists only verdicts the DNS server still blocks", async () => {
        await service.flaggedDomains("");
        const where = (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
        expect(where).toMatchObject({ flagged: true, expiresAt: { gt: expect.any(Date) } });
    });
});
