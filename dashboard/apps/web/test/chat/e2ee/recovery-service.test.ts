/**
 * Quorum recovery's server half against an in-memory database: who may raise a
 * request, that a share set is only stored when it matches the policy now,
 * that approvals are counted once and release at the threshold, that an
 * expired or foreign request is refused, that only the owner completes, and
 * that declines close a request exactly when the quorum is out of reach.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
    members: [] as Row[],
    orgs: [] as Row[],
    accountKeys: [] as Row[],
    shares: [] as Row[],
    recoveries: [] as Row[],
    requests: [] as Row[],
    approvals: [] as Row[],
    audits: [] as Row[],
    keys: [] as Row[],
    keyShares: [] as Row[],
    admins: [] as string[],
    told: [] as Array<{ userId: string; title: string }>,
    recorded: [] as Row[],
    seq: 0
}));

vi.mock("@polaris/db", () => {
    class PrismaClientKnownRequestError extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    }
    const matches = (row: Row, w: Row = {}): boolean =>
        Object.entries(w).every(([key, want]) => {
            if (key === "ownerId_custodianId") return matches(row, want as Row);
            if (key === "approvals") {
                const none = (want as { none: Row }).none;
                return !db.approvals.some((a) => a.requestId === row.id && matches(a, none));
            }
            const value = row[key];
            if (want === null) return value === null || value === undefined;
            if (want instanceof Date) return value instanceof Date && value.getTime() === want.getTime();
            if (want && typeof want === "object") {
                const ops = want as Row;
                if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
                if ("not" in ops && ops.not === null && (value === null || value === undefined)) return false;
                if ("gt" in ops && !((value as Date | number) > (ops.gt as Date | number))) return false;
                if ("gte" in ops && !((value as Date | number) >= (ops.gte as Date | number))) return false;
                return true;
            }
            return value === want;
        });
    type Order = Record<string, "asc" | "desc"> | Array<Record<string, "asc" | "desc">>;
    const sorted = (rows: Row[], order?: Order) => {
        const orderBy = Array.isArray(order) ? order[0] : order;
        if (!orderBy) return rows;
        const [[field, dir]] = Object.entries(orderBy) as [[string, "asc" | "desc"]];
        const n = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
        return [...rows].sort((a, b) => (n(a[field]) - n(b[field])) * (dir === "asc" ? 1 : -1));
    };
    const table = (rows: () => Row[], unique?: (a: Row, b: Row) => boolean) => ({
        findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, "asc" | "desc"> }) =>
            sorted(rows().filter((r) => matches(r, where)), orderBy)[0] ?? null,
        findUnique: async ({ where }: { where: Row }) => rows().find((r) => matches(r, where)) ?? null,
        findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Order; take?: number }) =>
            sorted(rows().filter((r) => matches(r, where)), orderBy).slice(0, take ?? Infinity),
        count: async ({ where }: { where?: Row }) => rows().filter((r) => matches(r, where)).length,
        create: async ({ data }: { data: Row }) => {
            if (unique && rows().some((r) => unique(r, data))) throw new PrismaClientKnownRequestError("P2002");
            const row = { id: `row-${++db.seq}`, createdAt: new Date(Date.now() + db.seq), status: "pending", ...data };
            rows().push(row);
            return row;
        },
        createMany: async ({ data }: { data: Row[] }) => {
            rows().push(...data);
            return { count: data.length };
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            const hit = rows().filter((r) => matches(r, where));
            for (const row of hit) Object.assign(row, data);
            return { count: hit.length };
        },
        deleteMany: async ({ where }: { where: Row }) => {
            const keep = rows().filter((r) => !matches(r, where));
            const count = rows().length - keep.length;
            rows().splice(0, rows().length, ...keep);
            return { count };
        }
    });
    const organization = table(() => db.orgs);
    const client = {
        organizationMember: table(() => db.members),
        organization: {
            ...organization,
            findUnique: async ({ where }: { where: { id: string } }) => {
                const org = db.orgs.find((o) => o.id === where.id);
                if (!org) return null;
                const admins = db.members
                    .filter((m) => m.orgId === org.id && m.role === "admin")
                    .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
                return { name: org.name, ownerId: org.ownerId, members: admins.map((m) => ({ userId: m.userId })) };
            }
        },
        chatAccountKey: table(() => db.accountKeys),
        chatRecoveryShare: table(() => db.shares),
        accountRecovery: table(() => db.recoveries),
        auditLog: table(() => db.audits),
        chatRecoveryRequest: table(() => db.requests),
        chatRecoveryKey: {
            ...table(() => db.keys),
            findMany: async (args: { where?: Row; orderBy?: Order; take?: number }) =>
                (await table(() => db.keys).findMany(args)).map((key) => ({
                    ...key,
                    shares: db.keyShares.filter((share) => share.keyId === key.id)
                }))
        },
        chatRecoveryKeyShare: table(() => db.keyShares),
        chatRecoveryApproval: table(
            () => db.approvals,
            (a, b) => a.requestId === b.requestId && a.custodianId === b.custodianId
        ),
        $transaction: async (work: unknown) =>
            typeof work === "function" ? (work as (tx: unknown) => unknown)(client) : Promise.all(work as unknown[])
    };
    return { prisma: client, Prisma: { PrismaClientKnownRequestError } };
});

vi.mock("@polaris/auth", () => ({ usersWithPermission: async () => db.admins }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async (entry: Row) => void db.recorded.push(entry) }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => (key: string) => key }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async ({ userId, title }: { userId: string; title: string }) => void db.told.push({ userId, title })
}));

import * as service from "@/lib/chat/e2ee/recovery-service";

const NOW = new Date("2026-11-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const bytes = (n: number) => new Uint8Array(n).fill(7);

function key(userId: string, akVersion = 1) {
    db.accountKeys.push({ userId, akVersion, hpkePublicKey: bytes(32) });
}

/** Acme: owner "own", admins "a1" and "a2"; "ana" is a member with a key. */
function acme() {
    db.orgs.push({ id: "acme", name: "Acme", ownerId: "own", createdAt: new Date(NOW.getTime() - 100 * DAY) });
    db.members.push(
        { orgId: "acme", userId: "ana", role: "member", createdAt: new Date(NOW.getTime() - 50 * DAY) },
        { orgId: "acme", userId: "a1", role: "admin", createdAt: new Date(NOW.getTime() - 90 * DAY) },
        { orgId: "acme", userId: "a2", role: "admin", createdAt: new Date(NOW.getTime() - 80 * DAY) }
    );
    for (const id of ["ana", "own", "a1", "a2"]) key(id);
}

/** Ana's 2-of-3 split as her browser would store it. */
async function anaShares() {
    await service.putShares("ana", {
        akVersion: 1,
        splitId: "split-1",
        threshold: 2,
        scope: "org:acme",
        shares: ["own", "a1", "a2"].map((custodianId) => ({ custodianId, custodianAkVersion: 1, envelope: bytes(64) }))
    });
}

function adminApproved(daysAgo = 1) {
    db.recoveries.push({ id: "rec-1", userId: "ana", status: "used", decidedAt: new Date(NOW.getTime() - daysAgo * DAY) });
}

beforeEach(() => {
    for (const list of [db.members, db.orgs, db.accountKeys, db.shares, db.recoveries, db.requests, db.approvals, db.audits, db.keys, db.keyShares, db.admins, db.told, db.recorded])
        list.length = 0;
    db.seq = 0;
});

describe("custodians and shares", () => {
    it("chooses the owner first, then administrators by seniority, 2 of 3", async () => {
        acme();
        const state = await service.recoveryState("ana");
        expect(state.scope).toBe("org:acme");
        expect(state.threshold).toBe(2);
        expect(state.custodians.map((c) => c.userId)).toEqual(["own", "a1", "a2"]);
    });

    it("falls back to the instance's administrators for an account in no organisation", async () => {
        key("solo");
        key("root");
        db.admins.push("root", "solo");
        const state = await service.recoveryState("solo");
        expect(state.scope).toBe("instance");
        expect(state.custodians.map((c) => c.userId)).toEqual(["root"]);
        expect(state.threshold).toBe(1);
    });

    it("stores a split that matches the policy, replacing the previous one", async () => {
        acme();
        await anaShares();
        await anaShares();
        expect(db.shares).toHaveLength(3);
        expect(new Set(db.shares.map((s) => s.splitId))).toEqual(new Set(["split-1"]));
    });

    it.each([
        ["an old key version", { akVersion: 0 }],
        ["another scope", { scope: "instance" }],
        ["another threshold", { threshold: 3 }]
    ])("refuses a split made for %s", async (_label, change) => {
        acme();
        const input = {
            akVersion: 1,
            splitId: "s",
            threshold: 2,
            scope: "org:acme",
            shares: ["own", "a1", "a2"].map((custodianId) => ({ custodianId, custodianAkVersion: 1, envelope: bytes(64) })),
            ...change
        };
        await expect(service.putShares("ana", input)).rejects.toMatchObject({ code: "stale" });
        expect(db.shares).toHaveLength(0);
    });

    it("refuses a split missing a custodian, sealed to an old custodian key, or oversized", async () => {
        acme();
        const base = { akVersion: 1, splitId: "s", threshold: 2, scope: "org:acme" };
        const share = (custodianId: string, custodianAkVersion = 1, size = 64) => ({ custodianId, custodianAkVersion, envelope: bytes(size) });
        await expect(service.putShares("ana", { ...base, shares: [share("own"), share("a1")] })).rejects.toMatchObject({ code: "stale" });
        await expect(service.putShares("ana", { ...base, shares: [share("own"), share("a1"), share("a2", 0)] })).rejects.toMatchObject({
            code: "stale"
        });
        await expect(service.putShares("ana", { ...base, shares: [share("own"), share("a1"), share("a2", 1, 5000)] })).rejects.toMatchObject({
            code: "stale"
        });
        expect(db.shares).toHaveLength(0);
    });

    it("refuses an account with no key", async () => {
        await expect(service.putShares("nobody", { akVersion: 1, splitId: "s", threshold: 0, scope: "instance", shares: [] })).rejects.toMatchObject({
            code: "noKey"
        });
    });
});

describe("raising a request", () => {
    it("is refused without a recent administrator-approved recovery", async () => {
        acme();
        await anaShares();
        await expect(service.openRequest("ana", bytes(32), NOW)).rejects.toMatchObject({ code: "notEligible" });
        adminApproved(8);
        await expect(service.openRequest("ana", bytes(32), NOW)).rejects.toMatchObject({ code: "notEligible" });
        expect((await service.ownRequest("ana", NOW)).eligible).toBe(false);
    });

    it("opens after the Security page's forgotten-password reset, with no administrator approval", async () => {
        acme();
        await anaShares();
        db.audits.push({ id: "old", actorId: "ana", action: "account.password.recovered", at: new Date(NOW.getTime() - 8 * DAY) });
        await expect(service.openRequest("ana", bytes(32), NOW)).rejects.toMatchObject({ code: "notEligible" });
        // Someone else's reset, or another action, does not count.
        db.audits.push({ id: "other", actorId: "a1", action: "account.password.recovered", at: NOW });
        db.audits.push({ id: "failed", actorId: "ana", action: "account.password.recovery-failed", at: NOW });
        expect((await service.ownRequest("ana", NOW)).eligible).toBe(false);
        db.audits.push({ id: "new", actorId: "ana", action: "account.password.recovered", at: new Date(NOW.getTime() - DAY) });
        expect((await service.ownRequest("ana", NOW)).eligible).toBe(true);
        const id = await service.openRequest("ana", bytes(32), NOW);
        expect(db.requests.find((r) => r.id === id)).toMatchObject({ status: "pending", accountRecoveryId: null });
        expect(db.recorded.find((r) => r.action === "chat.recovery.requested")?.metadata).toMatchObject({ via: "self" });
    });

    it("is refused with no shares to recover from", async () => {
        acme();
        adminApproved();
        await expect(service.openRequest("ana", bytes(32), NOW)).rejects.toMatchObject({ code: "noShares" });
    });

    it("opens, replaces a pending one, and tells the account and every custodian", async () => {
        acme();
        await anaShares();
        adminApproved();
        const first = await service.openRequest("ana", bytes(32), NOW);
        const second = await service.openRequest("ana", bytes(32), NOW);
        expect(db.requests.find((r) => r.id === first)?.status).toBe("cancelled");
        expect(db.requests.find((r) => r.id === second)).toMatchObject({ status: "pending", threshold: 2, accountRecoveryId: "rec-1" });
        expect(db.told.filter((t) => t.title === "security.chat_recovery_waiting").map((t) => t.userId).sort()).toEqual(["a1", "a1", "a2", "a2", "own", "own"]);
        expect(db.recorded.filter((r) => r.action === "chat.recovery.requested")).toHaveLength(2);
        const inbox = await service.custodianInbox("a1", NOW);
        expect(inbox.map((entry) => entry.id)).toEqual([second]);
    });
});

describe("approvals and declines", () => {
    async function opened() {
        acme();
        await anaShares();
        adminApproved();
        return service.openRequest("ana", bytes(32), NOW);
    }

    it("counts a repeated approval once and releases at the threshold", async () => {
        const id = await opened();
        expect(await service.approveRequest("own", id, bytes(80), NOW)).toEqual({ released: false });
        expect(await service.approveRequest("own", id, bytes(80), NOW)).toEqual({ released: false });
        expect(db.approvals).toHaveLength(1);
        expect(await service.approveRequest("a1", id, bytes(80), NOW)).toEqual({ released: true });
        expect(db.requests.find((r) => r.id === id)?.status).toBe("released");
        // Released, so no longer open to answers.
        await expect(service.approveRequest("a2", id, bytes(80), NOW)).rejects.toMatchObject({ code: "notFound" });
    });

    it("refuses an expired request, an unknown one, and a custodian with no share", async () => {
        const id = await opened();
        await expect(service.approveRequest("own", id, bytes(80), new Date(NOW.getTime() + 8 * DAY))).rejects.toMatchObject({ code: "notFound" });
        await expect(service.approveRequest("own", "nope", bytes(80), NOW)).rejects.toMatchObject({ code: "notFound" });
        await expect(service.approveRequest("ana", id, bytes(80), NOW)).rejects.toMatchObject({ code: "notFound" });
        await expect(service.approveRequest("own", id, bytes(5000), NOW)).rejects.toMatchObject({ code: "notFound" });
        expect(db.approvals).toHaveLength(0);
    });

    it("closes as declined only once the rest cannot reach the threshold", async () => {
        const id = await opened();
        expect(await service.declineRequest("own", id, NOW)).toEqual({ declined: false });
        expect(db.requests.find((r) => r.id === id)?.status).toBe("pending");
        expect(await service.declineRequest("a1", id, NOW)).toEqual({ declined: true });
        expect(db.requests.find((r) => r.id === id)?.status).toBe("declined");
        expect(db.told.some((t) => t.userId === "ana" && t.title === "security.chat_recovery_declined")).toBe(true);
    });

    it("never turns an approval into a decline", async () => {
        const id = await opened();
        await service.approveRequest("own", id, bytes(80), NOW);
        expect(await service.declineRequest("own", id, NOW)).toEqual({ declined: false });
        expect(db.approvals.find((a) => a.custodianId === "own")?.envelope).not.toBeNull();
        // One decline left two holders, one of whom approved: still reachable.
        expect(await service.declineRequest("a2", id, NOW)).toEqual({ declined: false });
        expect(await service.approveRequest("a1", id, bytes(80), NOW)).toEqual({ released: true });
    });

    it("lets only the owner complete a released request, once", async () => {
        const id = await opened();
        await service.approveRequest("own", id, bytes(80), NOW);
        await expect(service.completeRequest("ana", id)).rejects.toMatchObject({ code: "notFound" });
        await service.approveRequest("a1", id, bytes(80), NOW);
        await expect(service.completeRequest("own", id)).rejects.toMatchObject({ code: "notFound" });
        await service.completeRequest("ana", id);
        expect(db.requests.find((r) => r.id === id)?.status).toBe("completed");
        expect(db.approvals).toHaveLength(0);
        await expect(service.completeRequest("ana", id)).rejects.toMatchObject({ code: "notFound" });
    });
});

describe("the organisation recovery key", () => {
    const KEY_ID = "0190a000-0000-7000-8000-000000000001";
    const orkInput = (id = KEY_ID, change: Record<string, unknown> = {}) => ({
        id,
        scope: "org:acme",
        hpkePublicKey: bytes(1216),
        threshold: 2,
        shares: ["own", "a1", "a2"].map((custodianId) => ({ custodianId, custodianAkVersion: 1, envelope: bytes(64) })),
        ...change
    });

    it("lists the scopes an account is a custodian of, with no key yet", async () => {
        acme();
        expect(await service.recoveryKeyState("ana")).toEqual([]);
        const [entry] = await service.recoveryKeyState("a2");
        expect(entry).toMatchObject({ scope: "org:acme", threshold: 2, key: null });
        expect(entry!.custodians.map((c) => c.userId)).toEqual(["own", "a1", "a2"]);
    });

    it("stores the first key from a custodian, and reports it current until the custodians change", async () => {
        acme();
        expect(await service.putRecoveryKey("a1", orkInput(), NOW)).toEqual({ kept: true });
        expect(db.keyShares).toHaveLength(3);
        expect((await service.recoveryKeyState("own"))[0]!.key).toEqual({ id: KEY_ID, current: true });
        db.accountKeys.find((k) => k.userId === "a2")!.akVersion = 2;
        expect((await service.recoveryKeyState("own"))[0]!.key).toEqual({ id: KEY_ID, current: false });
        // A second key for the same scope is refused while one is live.
        await expect(service.putRecoveryKey("own", orkInput("0190a000-0000-7000-8000-000000000002", {
            shares: ["own", "a1", "a2"].map((custodianId) => ({ custodianId, custodianAkVersion: custodianId === "a2" ? 2 : 1, envelope: bytes(64) }))
        }), NOW)).rejects.toMatchObject({ code: "stale" });
    });

    it("refuses a non-custodian and a split that does not match the policy", async () => {
        acme();
        await expect(service.putRecoveryKey("ana", orkInput(), NOW)).rejects.toMatchObject({ code: "notFound" });
        await expect(service.putRecoveryKey("a1", orkInput(KEY_ID, { threshold: 1 }), NOW)).rejects.toMatchObject({ code: "stale" });
        await expect(service.putRecoveryKey("a1", orkInput(KEY_ID, { shares: orkInput().shares.slice(0, 2) }), NOW)).rejects.toMatchObject({
            code: "stale"
        });
        expect(db.keys).toHaveLength(0);
    });

    it("keeps one live key when two custodians create at once", async () => {
        acme();
        const results = await Promise.allSettled([
            service.putRecoveryKey("own", orkInput(), NOW),
            service.putRecoveryKey("a1", orkInput("0190a000-0000-7000-8000-000000000002"), NOW)
        ]);
        expect(db.keys.filter((k) => !k.retiredAt)).toHaveLength(1);
        expect(results.filter((r) => r.status === "fulfilled" && r.value.kept)).toHaveLength(1);
    });

    it("makes fellow custodians of the key, the caller included, key-log peers", async () => {
        acme();
        // a1's own custodians are own and a2; the key adds a1 itself.
        const peers = await service.recoveryPeers("a1");
        expect([...peers].sort()).toEqual(["a1", "a2", "own"]);
    });

    it("finds the live key of the scope each keyless account belongs to", async () => {
        acme();
        await service.putRecoveryKey("a1", orkInput(), NOW);
        const { liveRecoveryKeysFor } = await import("@/lib/chat/e2ee/recovery-keys");
        expect((await liveRecoveryKeysFor(["ana", "stranger"])).map((k) => k.id)).toEqual([KEY_ID]);
        expect(await liveRecoveryKeysFor(["stranger"])).toEqual([]);
    });
});
