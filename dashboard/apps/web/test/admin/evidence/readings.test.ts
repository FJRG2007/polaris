/**
 * Gathering the evidence, against a fake database: each figure is read from the
 * column that holds it, counted over accounts that can sign in, and a backup's
 * encryption is judged from its newest copy only.
 */

import { describe, expect, it, vi } from "vitest";

const VISIBLE_USER = { bannedAt: null, disabledAt: null };

type Where = Record<string, unknown>;

/** Answers a count by which column the query narrows on. */
function countBy(answers: Record<string, number>, fallback: number) {
    return vi.fn(async ({ where = {} }: { where?: Where } = {}) => {
        for (const [key, value] of Object.entries(answers)) if (key in where) return value;
        return fallback;
    });
}

const prisma = {
    user: {
        count: countBy({ twoFactorEnabled: 8, passkeys: 2 }, 10),
        findMany: vi.fn(async ({ where }: { where: Where }) =>
            "isAdmin" in where
                ? [{ id: "u1", name: "", username: "ada", email: "ada@example.com", twoFactorEnabled: false }]
                : [{ id: "u1", name: "", username: "ada", email: "ada@example.com" }]
        )
    },
    userSecurity: {
        count: countBy(
            {
                sessionMaxMinutes: 1,
                idleLockMinutes: 2,
                bindSessionsToClient: 3,
                pinSessionsToAddress: 4,
                requireLoginApproval: 5
            },
            0
        )
    },
    session: { count: vi.fn(async () => 21) },
    // 250 items in all; only r1 and r2 are listed, and r3 - past the list - has
    // a newest copy that is sealed everywhere.
    protectedResource: {
        count: countBy({ status: 180, lastStatus: 7 }, 250),
        findMany: vi.fn(async ({ where }: { where?: Where } = {}) =>
            where && "points" in where
                ? [{ id: "r1" }, { id: "r3" }]
                : [
                      {
                          id: "r1",
                          name: "Volume",
                          kind: "deploy-volume",
                          status: "active",
                          lastBackupAt: new Date("2026-09-09T00:00:00.000Z"),
                          lastStatus: "ok",
                          plan: { every: "daily" }
                      },
                      {
                          id: "r2",
                          name: "World",
                          kind: "minecraft-world",
                          status: "active",
                          lastBackupAt: null,
                          lastStatus: null,
                          plan: null
                      }
                  ]
        )
    },
    backupKey: { count: vi.fn(async () => 1) },
    recoveryPoint: {
        groupBy: vi.fn(async () => [
            { resourceId: "r1", _max: { takenAt: new Date("2026-09-09T00:00:00.000Z") } },
            { resourceId: "r3", _max: { takenAt: new Date("2026-08-01T00:00:00.000Z") } }
        ]),
        findMany: vi.fn(async () => [
            { id: "p1", resourceId: "r1" },
            { id: "p3", resourceId: "r3" }
        ])
    },
    recoveryPointCopy: {
        findMany: vi.fn(async () => [
            { pointId: "p1", sealedWith: "k1", path: "a.tar.sealed" },
            { pointId: "p1", sealedWith: null, path: "b.tar" },
            { pointId: "p3", sealedWith: "k1", path: "c.tar.sealed" }
        ])
    },
    // Secret variables: 6 in all, one of them with no encrypted value; 9 plain.
    envVar: {
        count: vi.fn(async ({ where }: { where: Where }) => {
            if (where.isSecret === false) return 9;
            return "encryptedValue" in where ? 1 : 6;
        })
    },
    runnerSecret: { count: vi.fn(async () => 4) },
    domain: {
        count: vi.fn(async ({ where }: { where: Where }) => {
            if (where.certResolver === "le") return 5;
            if (where.certResolver === "internal") return 1;
            if (where.certResolver === "none") return 2;
            if ("certPem" in where) return 1;
            return 8;
        })
    },
    managedCertificate: {
        findMany: vi.fn(async () => [
            { status: "issued", expiresAt: new Date("2026-12-01T00:00:00.000Z") },
            { status: "failed", expiresAt: null }
        ])
    },
    wafBan: { count: vi.fn(async () => 3) },
    application: {
        findMany: vi.fn(async () => [
            { edgeConfig: JSON.stringify({ rateLimits: [{ average: 10, burst: 20 }], headers: { preset: "strict" } }) },
            { edgeConfig: "{}" }
        ])
    },
    auditLog: {
        findFirst: vi.fn(async ({ where }: { where: { action: { in: string[] } } }) =>
            where.action.in.includes("instance.security.updated")
                ? { at: new Date("2026-09-01T00:00:00.000Z"), action: "instance.security.updated", actorId: "u1" }
                : null
        )
    }
};

vi.mock("@polaris/db", () => ({ prisma, VISIBLE_USER }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_BUILD_SHA: "0123456789abcdef0123" }) }));
vi.mock("@polaris/auth", () => ({ MIN_PASSWORD_LENGTH: 10, SESSION_MAX_AGE: 604_800, SESSION_UPDATE_AGE: 86_400 }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));
vi.mock("@/lib/auth-mail", () => ({ getAuthMailStatus: async () => ({ channelId: null }) }));
vi.mock("@/lib/instance-security", () => ({
    getInstanceSecurity: async () => ({
        requireSecondFactor: true,
        acceptedFactors: ["totp", "email"],
        challengeConnectionSignIn: false
    })
}));
vi.mock("@/lib/retention-service", () => ({
    retentionPolicy: async () => ({ notifications: 30, activity: 365, audit: 0 })
}));
vi.mock("@/lib/audit-chain", () => ({
    auditChainStatus: async () => ({
        sealed: 10,
        pending: 2,
        head: { seq: "10", hash: "e".repeat(64) },
        checkpoint: null,
        lastVerification: null
    })
}));
vi.mock("@/lib/waf-service", () => ({
    wafSummary: async () => ({
        instancePacks: 6,
        instanceDefaults: true,
        polarisPacks: 9,
        polarisDefaults: true,
        scopes: 0,
        customRules: 0,
        denyEntries: 0,
        allowScopes: 0,
        loginScopes: 0,
        injectionOffScopes: 0
    })
}));

const { readEvidence } = await import("@/lib/compliance/evidence-readings");

const NOW = new Date("2026-09-10T12:00:00.000Z");

function value(report: Awaited<ReturnType<typeof readEvidence>>, area: string, id: string) {
    return report.sections.find((section) => section.id === area)?.facts.find((fact) => fact.id === id)?.value;
}

describe("gathering the evidence", () => {
    it("stamps the instance and the moment", async () => {
        const report = await readEvidence(NOW);
        expect(report.generatedAt).toBe(NOW.toISOString());
        expect(report.instance).toEqual({ url: "https://polaris.example.com", build: "0123456789ab" });
    });

    it("counts accounts that can sign in, and second factors among them", async () => {
        const report = await readEvidence(NOW);
        expect(value(report, "authentication", "accounts.second-factor")).toBe(8);
        expect(value(report, "authentication", "accounts.passkey")).toBe(2);
        for (const call of prisma.user.count.mock.calls) {
            expect(call[0]?.where).toMatchObject(VISIBLE_USER);
        }
        expect(value(report, "sessions", "session.client-binding")).toBe(10 - 3);
        expect(value(report, "sessions", "session.open")).toBe(21);
    });

    it("names an administrator by handle when they set no name, and flags the missing factor", async () => {
        const report = await readEvidence(NOW);
        const admins = report.sections.find((section) => section.id === "administrators");
        expect(admins?.rows?.items[0]?.label).toBe("@ada");
        expect(value(report, "administrators", "admins.without-second-factor")).toBe(1);
    });

    it("tells encrypted secrets from the ones stored in the clear", async () => {
        const report = await readEvidence(NOW);
        expect(value(report, "secrets", "secrets.encrypted")).toBe(5);
        expect(value(report, "secrets", "secrets.clear")).toBe(1);
        expect(value(report, "secrets", "variables.plain")).toBe(9);
        expect(value(report, "secrets", "runner-secrets.encrypted")).toBe(4);
    });

    it("judges a backup by its newest copies, and an item with none as having none", async () => {
        const report = await readEvidence(NOW);
        const rows = report.sections.find((section) => section.id === "backups")?.rows?.items ?? [];
        expect(rows.map((row) => row.facts.find((fact) => fact.id === "encrypted")?.text)).toEqual([
            "Partly",
            "No copy yet"
        ]);
        expect(prisma.recoveryPointCopy.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { pointId: { in: ["p1", "p3"] }, status: "available" } })
        );
    });

    it("counts the backup figures over every item, not only the listed ones", async () => {
        const report = await readEvidence(NOW);
        expect(value(report, "backups", "backups.protected")).toBe(250);
        expect(value(report, "backups", "backups.scheduled")).toBe(180);
        expect(value(report, "backups", "backups.failing")).toBe(7);
        expect(value(report, "backups", "backups.encrypted")).toBe(1);
        expect(prisma.protectedResource.count).toHaveBeenCalledWith({
            where: { status: "active", plan: { is: { every: { not: "off" } } } }
        });
    });

    it("reads one newest point per item rather than every point", async () => {
        await readEvidence(NOW);
        expect(prisma.recoveryPoint.groupBy).toHaveBeenCalledWith(
            expect.objectContaining({ by: ["resourceId"], where: expect.objectContaining({ resourceId: { in: ["r1", "r3"] } }) })
        );
        for (const call of prisma.recoveryPoint.findMany.mock.calls as unknown as [Where][]) {
            expect(call[0]).not.toHaveProperty("distinct");
        }
    });

    it("reads TLS, the edge and the retention the way they are stored", async () => {
        const report = await readEvidence(NOW);
        expect(value(report, "tls", "tls.with-certificate")).toBe(6);
        expect(value(report, "tls", "tls.plain-http")).toBe(2);
        expect(value(report, "tls", "tls.managed-failed")).toBe(1);
        expect(value(report, "rate-limits", "rate.services")).toBe(1);
        expect(value(report, "headers", "headers.strict")).toBe(1);
        expect(value(report, "headers", "headers.off")).toBe(1);
        expect(value(report, "audit", "audit.retention-days")).toBe(0);
        expect(value(report, "firewall", "firewall.bans")).toBe(3);
    });

    it("finds each area's last change and who made it", async () => {
        const report = await readEvidence(NOW);
        const auth = report.sections.find((section) => section.id === "authentication");
        expect(auth?.lastChange).toEqual({
            at: "2026-09-01T00:00:00.000Z",
            action: "instance.security.updated",
            actorId: "u1",
            actorName: "@ada",
            actorExists: true
        });
        expect(report.sections.find((section) => section.id === "tls")?.lastChange).toBeNull();
        expect(auth?.notes.join(" ")).toMatch(/no email channel/);
    });
});
