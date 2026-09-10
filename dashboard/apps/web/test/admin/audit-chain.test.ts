/**
 * The audit trail's tamper evidence.
 *
 * What is asserted is what an auditor would try: change an entry after it was
 * sealed, delete one out of the middle, re-point one at a different predecessor -
 * each has to be reported, at the entry where it happened. And the one thing the
 * chain must survive on purpose: retention cutting its oldest end, after which
 * everything left still has to verify.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    at: Date;
    actorId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: string | null;
    ipHash: string | null;
    sessionId: string | null;
    orgId: string | null;
    seq: bigint | null;
    prevHash: string | null;
    hash: string | null;
}

let rows: Row[] = [];
let checkpoints: { seq: bigint; hash: string; pruned: number; at: Date }[] = [];
let settings = new Map<string, string>();

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    for (const [key, condition] of Object.entries(where)) {
        const value = (row as unknown as Record<string, unknown>)[key];
        if (key === "id" && condition && typeof condition === "object" && "in" in condition) {
            if (!(condition.in as string[]).includes(row.id)) return false;
            continue;
        }
        if (condition === null) {
            if (value !== null) return false;
            continue;
        }
        if (condition && typeof condition === "object") {
            const test = condition as { not?: null; gte?: bigint };
            if ("not" in test && value === null) return false;
            if (test.gte !== undefined && (value === null || (value as bigint) < test.gte))
                return false;
            continue;
        }
        if (value !== condition) return false;
    }
    return true;
}

function ordered(list: Row[], orderBy: unknown): Row[] {
    const copy = [...list];
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
    copy.sort((left, right) => {
        for (const key of keys as Record<string, "asc" | "desc">[]) {
            const [field, direction] = Object.entries(key)[0] ?? ["id", "asc"];
            const a = (left as unknown as Record<string, unknown>)[field] as bigint | Date | string;
            const b = (right as unknown as Record<string, unknown>)[field] as
                | bigint
                | Date
                | string;
            const cmp = a < b ? -1 : a > b ? 1 : 0;
            if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
        }
        return 0;
    });
    return copy;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        auditLog: {
            findMany: async ({
                where,
                orderBy,
                take
            }: {
                where?: Record<string, unknown>;
                orderBy: unknown;
                take: number;
            }) =>
                ordered(
                    rows.filter((row) => matches(row, where)),
                    orderBy
                ).slice(0, take),
            findFirst: async ({
                where,
                orderBy
            }: {
                where?: Record<string, unknown>;
                orderBy: unknown;
            }) =>
                ordered(
                    rows.filter((row) => matches(row, where)),
                    orderBy
                )[0] ?? null,
            update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const row = rows.find((entry) => entry.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            },
            count: async ({ where }: { where?: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where)).length,
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const before = rows.length;
                rows = rows.filter((row) => !matches(row, where));
                return { count: before - rows.length };
            }
        },
        auditCheckpoint: {
            findFirst: async () =>
                [...checkpoints].sort((a, b) => (a.seq < b.seq ? 1 : -1))[0] ?? null,
            upsert: async ({
                create
            }: {
                create: { seq: bigint; hash: string; pruned: number };
            }) => {
                checkpoints.push({ ...create, at: new Date() });
                return create;
            }
        },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));

vi.mock("@polaris/config", () => ({
    // 32 bytes, base64: a fixture key, not anybody's.
    loadEnv: () => ({ POLARIS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64") })
}));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
        settings.set(key, value);
    }
}));

const { sealAuditChain, verifyAuditChain, pruneSealedAudit, chainLink } = await import(
    "@/lib/audit-chain"
);
const core = await import("@polaris/core");

function entry(index: number, minutesAgo: number): Row {
    return {
        id: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
        at: new Date(Date.now() - minutesAgo * 60_000),
        actorId: null,
        action: `test.action.${index}`,
        targetType: null,
        targetId: null,
        metadata: JSON.stringify({ index }),
        ipHash: null,
        sessionId: null,
        orgId: null,
        seq: null,
        prevHash: null,
        hash: null
    };
}

beforeEach(() => {
    // Written out of order on purpose: sealing goes by time, not by insert.
    rows = [entry(3, 10), entry(1, 30), entry(2, 20), entry(4, 5)];
    checkpoints = [];
    settings = new Map();
});

describe("sealing", () => {
    it("links every entry to the one before it, oldest first", async () => {
        expect(await sealAuditChain()).toBe(4);
        const chain = [...rows].sort((a, b) => Number((a.seq ?? 0n) - (b.seq ?? 0n)));
        expect(chain.map((row) => row.action)).toEqual([
            "test.action.1",
            "test.action.2",
            "test.action.3",
            "test.action.4"
        ]);
        expect(chain[0]?.prevHash).toBe(core.AUDIT_CHAIN_GENESIS);
        for (let index = 1; index < chain.length; index += 1) {
            expect(chain[index]?.prevHash).toBe(chain[index - 1]?.hash);
        }
    });

    it("continues the chain from its head on the next pass", async () => {
        await sealAuditChain();
        rows.push(entry(5, 1));
        expect(await sealAuditChain()).toBe(1);
        const last = rows.find((row) => row.action === "test.action.5");
        const previous = rows.find((row) => row.action === "test.action.4");
        expect(last?.seq).toBe(5n);
        expect(last?.prevHash).toBe(previous?.hash);
    });

    it("is keyed, so a link is not a plain digest anybody could recompute", async () => {
        await sealAuditChain();
        const first = rows.find((row) => row.seq === 1n)!;
        const { createHash } = await import("node:crypto");
        const plain = createHash("sha256")
            .update(
                core.auditChainPayload({ ...first, seq: 1n, prevHash: core.AUDIT_CHAIN_GENESIS })
            )
            .digest("hex");
        expect(first.hash).not.toBe(plain);
        expect(first.hash).toBe(chainLink(first, 1n, core.AUDIT_CHAIN_GENESIS));
    });
});

describe("verifying", () => {
    beforeEach(async () => {
        await sealAuditChain();
    });

    it("finds an untouched chain intact, and remembers that it did", async () => {
        const result = await verifyAuditChain();
        expect(result).toMatchObject({ ok: true, checked: 4, broken: null });
        expect(settings.get("audit.chain.lastVerify")).toContain('"ok":true');
    });

    it("reports an entry edited after it was sealed", async () => {
        rows.find((row) => row.seq === 2n)!.metadata = JSON.stringify({ index: 999 });
        const result = await verifyAuditChain();
        expect(result.ok).toBe(false);
        expect(result.broken).toMatchObject({ seq: "2", reason: "altered" });
    });

    it("reports an entry deleted from the middle", async () => {
        rows = rows.filter((row) => row.seq !== 3n);
        const result = await verifyAuditChain();
        expect(result.broken).toMatchObject({ seq: "3", reason: "missing" });
    });

    it("reports an entry pointed at a different predecessor", async () => {
        rows.find((row) => row.seq === 4n)!.prevHash = "f".repeat(64);
        const result = await verifyAuditChain();
        expect(result.broken).toMatchObject({ seq: "4", reason: "relinked" });
    });
});

describe("retention", () => {
    beforeEach(async () => {
        await sealAuditChain();
    });

    it("removes only a sealed prefix, records the cut, and leaves the rest verifiable", async () => {
        // Entries 1 and 2 are older than the cutoff; 3 and 4 are not.
        const cutoff = new Date(Date.now() - 15 * 60_000);
        const cut = await pruneSealedAudit(cutoff, 100);
        expect(cut).toEqual({ removed: 2, more: false });
        expect(rows.map((row) => row.seq).sort()).toEqual([3n, 4n]);
        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0]?.seq).toBe(2n);

        expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 2 });
    });

    it("stops at the first entry inside the period, even if later ones are older", async () => {
        // An entry sealed late with an early timestamp must not open a gap.
        const third = rows.find((row) => row.seq === 3n)!;
        third.at = new Date();
        rows.find((row) => row.seq === 4n)!.at = new Date(Date.now() - 60 * 60_000);
        const cut = await pruneSealedAudit(new Date(Date.now() - 15 * 60_000), 100);
        expect(cut.removed).toBe(2);
        expect(rows.map((row) => row.seq).sort()).toEqual([3n, 4n]);
    });

    it("continues sealing from the cut once everything sealed has gone", async () => {
        await pruneSealedAudit(new Date(Date.now() + 60_000), 100);
        expect(rows).toHaveLength(0);
        rows.push(entry(9, 0));
        await sealAuditChain();
        expect(rows[0]?.seq).toBe(5n);
        expect(await verifyAuditChain()).toMatchObject({ ok: true, checked: 1 });
    });
});
