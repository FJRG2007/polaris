/**
 * Carrying out a DNS cutover against a store held in memory: the background pass
 * looks at a bounded number of cutovers and does each step once however often it
 * runs, Switch and Rollback pressed twice do the work once, a record Cloudflare
 * refused can be switched again, and the screen only asks for a fresh check when
 * the last one is old.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    domainId: string;
    hostname: string;
    sourceApplicationId: string;
    targetApplicationId: string;
    actorId: string | null;
    openKey: string | null;
    phase: string;
    mode: string;
    oldValues: string;
    newValue: string | null;
    oldTtl: number | null;
    zoneId: string | null;
    recordIds: string;
    checks: string;
    failure: string | null;
    passes: number;
    lowerUntil: Date | null;
    switchedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const state = vi.hoisted(() => ({
    rows: new Map<string, Row>(),
    domainApp: "app-old",
    passQueries: [] as unknown[],
    audits: [] as string[],
    saved: [] as { id: string | null; content: string; ttl: number }[],
    deleted: [] as string[],
    saveFails: 0,
    probes: 0,
    published: 0,
    settled: true,
    targetUp: true
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
        const actual = (row as unknown as Record<string, unknown>)[key];
        if (value && typeof value === "object" && !(value instanceof Date)) {
            const filter = value as { not?: unknown; in?: unknown[] };
            if ("not" in filter && actual === filter.not) return false;
            if (filter.in && !filter.in.includes(actual)) return false;
        } else if (actual !== value) return false;
    }
    return true;
}

function apply(row: Row, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in (value as object)) {
            (row as unknown as Record<string, number>)[key] += (value as { increment: number }).increment;
        } else (row as unknown as Record<string, unknown>)[key] = value;
    }
    row.updatedAt = new Date();
}

vi.mock("@polaris/db", () => {
    const dnsCutover = {
        findMany: async (args: { where: Record<string, unknown>; take?: number }) => {
            state.passQueries.push(args);
            return [...state.rows.values()].filter((row) => matches(row, args.where)).slice(0, args.take);
        },
        // Copies, as a database hands back: a later write never reaches a row already read.
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
            const row = [...state.rows.values()].find((candidate) => matches(candidate, where));
            return row ? { ...row } : null;
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
            const row = [...state.rows.values()].filter((candidate) => matches(candidate, where)).at(-1);
            return row ? { ...row } : null;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = state.rows.get(where.id);
            if (!row) throw new Error("missing");
            apply(row, data);
            return row;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            const hit = [...state.rows.values()].filter((row) => matches(row, where));
            for (const row of hit) apply(row, data);
            return { count: hit.length };
        }
    };
    const owner = { project: { ownerId: "user-1", orgId: null }, projectId: "project-1", name: "production" };
    const app = (id: string) => ({
        id,
        name: id,
        environmentId: "env-1",
        currentDeploymentId: "dep-1",
        sourceType: "image",
        sourceConfig: "{}",
        domains: [],
        environment: owner,
        target: { kind: "host", hostId: id === "app-old" ? "host-1" : "host-2", host: { name: id, address: "203.0.113.7" } }
    });
    return {
        prisma: {
            dnsCutover,
            domain: {
                findUnique: async () => ({
                    id: "domain-1",
                    hostname: "shop.example.com",
                    https: true,
                    servedBy: "auto",
                    certPem: null,
                    certResolver: "le",
                    targetPort: 3000,
                    portPinned: false,
                    applicationId: state.domainApp,
                    application: app(state.domainApp)
                }),
                update: async ({ data }: { data: { applicationId: string } }) => {
                    state.domainApp = data.applicationId;
                }
            },
            application: {
                findUnique: async ({ where }: { where: { id: string } }) => app(where.id),
                findMany: async () => [app("app-old"), app("app-new")]
            },
            ownerDomain: { findUnique: async () => null }
        }
    };
});
vi.mock("@/lib/deploy-service", () => ({
    containerPortOf: () => 3000,
    syncAppRoutes: async () => {
        state.published += 1;
        return { unreachedHosts: new Set() };
    }
}));
vi.mock("@/lib/deploy-audit", () => ({
    recordDeployAudit: async (event: { action: string }) => {
        state.audits.push(event.action);
    }
}));
vi.mock("@/lib/watch/health-probe", () => ({
    checkDomain: async () => {
        state.probes += 1;
        return state.targetUp
            ? { status: "up", code: 200, latencyMs: 5, detail: null }
            : { status: "down", code: null, latencyMs: null, detail: "timeout" };
    }
}));
vi.mock("@/lib/dns/propagation", () => ({
    checkPropagation: async () => ({
        settled: state.settled,
        resolvers: [{ label: "Cloudflare", status: "answered", values: ["203.0.113.7"], agrees: state.settled }]
    })
}));
vi.mock("@/lib/dns/public-resolver", () => ({ publicResolver: () => ({ resolve4: async () => [] }) }));
vi.mock("@/lib/domain-dns", () => ({ serviceDnsTarget: async () => ({ ip: "203.0.113.7" }) }));
vi.mock("@/lib/dns/zone-records", () => ({ provenDomainOf: async () => null }));
vi.mock("@/lib/tls/managed-certificates", () => ({ openText: () => null }));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: async () => "token" }));
vi.mock("@/lib/integrations/cloudflare-api", () => ({
    resolveZoneForHostname: async () => ({ id: "zone-1" }),
    findDnsRecords: async () => [],
    saveDnsRecord: async (_token: string, _zone: string, id: string | null, record: { content: string; ttl: number }) => {
        if (state.saveFails > 0) {
            state.saveFails -= 1;
            throw new Error("refused");
        }
        state.saved.push({ id, content: record.content, ttl: record.ttl });
        return { id: id ?? "record-new" };
    },
    deleteDnsRecord: async (_token: string, _zone: string, id: string) => {
        state.deleted.push(id);
    }
}));

import * as service from "@/lib/deploy/dns-cutover-service";

const NOW = Date.now();

function seed(id: string, overrides: Partial<Row> = {}): Row {
    const row: Row = {
        id,
        domainId: "domain-1",
        hostname: "shop.example.com",
        sourceApplicationId: "app-old",
        targetApplicationId: "app-new",
        actorId: "user-1",
        openKey: "domain-1",
        phase: "ready",
        mode: "cloudflare",
        oldValues: JSON.stringify(["198.51.100.4"]),
        newValue: "203.0.113.7",
        oldTtl: 3600,
        zoneId: "zone-1",
        recordIds: JSON.stringify({
            records: [{ id: "record-1", content: "198.51.100.4", ttl: 60, proxied: false }],
            created: null
        }),
        checks: "{}",
        failure: null,
        passes: 0,
        lowerUntil: null,
        switchedAt: null,
        finishedAt: null,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
        ...overrides
    };
    state.rows.set(id, row);
    return row;
}

beforeEach(() => {
    state.rows.clear();
    state.domainApp = "app-old";
    state.passQueries = [];
    state.audits = [];
    state.saved = [];
    state.deleted = [];
    state.saveFails = 0;
    state.probes = 0;
    state.published = 0;
    state.settled = true;
    state.targetUp = true;
});

describe("the background pass", () => {
    it("looks only at open cutovers waiting on time or DNS, and at most twenty of them", async () => {
        await service.runCutoverPass();
        expect(state.passQueries[0]).toMatchObject({
            where: { openKey: { not: null }, phase: { in: ["lowering", "propagating", "finishing"] } },
            take: 20
        });
    });

    it("leaves untouched what it is not waiting on", async () => {
        seed("ready", { openKey: "domain-1" });
        seed("closed", { openKey: null, phase: "done" });
        expect(await service.runCutoverPass()).toEqual({ looked: 0 });
        expect(state.rows.get("ready")?.phase).toBe("ready");
    });

    it("hands the domain over once, however many passes run", async () => {
        seed("c1", { phase: "propagating", switchedAt: new Date(NOW - 60_000) });
        await Promise.all([service.runCutoverPass(), service.runCutoverPass()]);
        await service.runCutoverPass();
        expect(state.rows.get("c1")).toMatchObject({ phase: "done", openKey: null });
        expect(state.audits.filter((action) => action === "deploy.domain.cutover.finish")).toHaveLength(1);
        expect(state.domainApp).toBe("app-new");
        // The TTL went back to what it was before the cutover lowered it. Two passes
        // that both reach the hand-over may each write it, and write the same thing.
        expect(state.saved.length).toBeGreaterThan(0);
        for (const write of state.saved) {
            expect(write).toEqual({ id: "record-1", content: "203.0.113.7", ttl: 3600 });
        }
    });

    it("keeps waiting, and keeps the old service, while the resolvers disagree", async () => {
        state.settled = false;
        seed("c1", { phase: "propagating", switchedAt: new Date(NOW - 60_000) });
        await service.runCutoverPass();
        await service.runCutoverPass();
        expect(state.rows.get("c1")).toMatchObject({ phase: "propagating", passes: 2 });
        expect(state.domainApp).toBe("app-old");
        expect(JSON.parse(state.rows.get("c1")?.checks ?? "{}").propagation.settled).toBe(false);
    });

    it("ends the lowering once the old TTL has run out", async () => {
        seed("c1", { phase: "lowering", lowerUntil: new Date(NOW - 1000) });
        await service.runCutoverPass();
        expect(state.rows.get("c1")?.phase).toBe("ready");
        expect(state.probes).toBe(0);
    });
});

describe("switching", () => {
    it("writes the record once when pressed twice", async () => {
        seed("c1");
        await service.switchCutover("c1", "user-1");
        await service.switchCutover("c1", "user-1");
        expect(state.saved).toEqual([{ id: "record-1", content: "203.0.113.7", ttl: 60 }]);
        expect(state.rows.get("c1")?.phase).toBe("propagating");
        expect(state.audits).toEqual(["deploy.domain.cutover.switch"]);
    });

    it("stays where it was when Cloudflare refuses, and switches when tried again", async () => {
        seed("c1");
        state.saveFails = 1;
        await service.switchCutover("c1", "user-1");
        expect(state.rows.get("c1")).toMatchObject({
            phase: "ready",
            failure: "record-write-failed",
            switchedAt: null
        });
        await service.switchCutover("c1", "user-1");
        expect(state.rows.get("c1")).toMatchObject({ phase: "propagating", failure: null });
    });
});

describe("rolling back", () => {
    it("puts the record back and closes, and does nothing a second time", async () => {
        seed("c1");
        await service.switchCutover("c1", "user-1");
        await service.rollbackCutover("c1", "user-1");
        await service.rollbackCutover("c1", "user-1");
        expect(state.rows.get("c1")).toMatchObject({ phase: "rolled-back", openKey: null });
        expect(state.saved.at(-1)).toEqual({ id: "record-1", content: "198.51.100.4", ttl: 60 });
        expect(state.audits.filter((action) => action === "deploy.domain.cutover.rollback")).toHaveLength(1);
        expect(state.domainApp).toBe("app-old");
    });

    it("is refused once there is nothing open to roll back", async () => {
        await expect(service.openCutoverId("domain-1")).rejects.toMatchObject({ reason: "closed" });
    });
});

describe("the screen's view", () => {
    it("checks again only when the last check is older than the gap", async () => {
        seed("c1", {
            phase: "propagating",
            switchedAt: new Date(NOW - 60_000),
            checks: JSON.stringify({ checkedAt: new Date().toISOString() })
        });
        const fresh = await service.cutoverPanel("domain-1", null);
        expect(state.probes).toBe(0);
        expect(fresh.cutover?.phase).toBe("propagating");

        state.rows.get("c1")!.checks = JSON.stringify({ checkedAt: new Date(NOW - 60_000).toISOString() });
        const checked = await service.cutoverPanel("domain-1", null);
        expect(state.probes).toBe(1);
        expect(checked.cutover?.phase).toBe("done");
        expect(checked.targets.map((target) => target.id)).toEqual(["app-old", "app-new"]);
    });
});
