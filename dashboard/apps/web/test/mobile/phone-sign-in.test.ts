/**
 * Passwordless sign-in by phone approval: the request is bound to the asking
 * browser's secret, the number is mandatory, an approval is handed over once,
 * and a request of one purpose can never be collected as the other.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
    id: string;
    userId: string;
    challengeHash: string;
    status: string;
    matchNumber: number | null;
    reason: string | null;
    purpose: string;
    expiresAt: Date;
    decidedAt: Date | null;
};

const rows = new Map<string, Row>();
let next = 0;

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(where)) {
        const actual = row[key as keyof Row];
        if (key === "expiresAt") {
            if (!(actual instanceof Date && actual > (expected as { gt: Date }).gt)) return false;
        } else if (key === "id" && typeof expected === "object" && expected !== null) {
            if (!(expected as { in: string[] }).in.includes(row.id)) return false;
        } else if (actual !== expected) return false;
    }
    return true;
}

vi.mock("@polaris/auth", () => ({ noteSecondFactor: async () => undefined }));
vi.mock("@polaris/db", () => ({
    prisma: {
        mobileDeviceKey: { findFirst: async () => ({ id: "k1" }) },
        verification: { deleteMany: () => undefined, create: () => undefined },
        $transaction: async () => undefined,
        signInApproval: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                [...rows.values()].filter((row) => matches(row, where)),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                [...rows.values()].find((row) => matches(row, where)) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
            create: async ({ data }: { data: Omit<Row, "id" | "status" | "reason" | "decidedAt"> }) => {
                next += 1;
                const id = `0190a3b2-0000-7000-8000-${String(next).padStart(12, "0")}`;
                rows.set(id, { ...data, id, status: "pending", reason: null, decidedAt: null } as Row);
                return { id };
            },
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
                const found = [...rows.values()].filter((row) => matches(row, where));
                for (const row of found) Object.assign(row, data);
                return { count: found.length };
            },
            count: async () => 0
        }
    }
}));

const { collectApproval, collectSignIn, decideApproval, requestApproval, approvalPurpose } = await import(
    "@/lib/mobile/sign-in-approval"
);

const SECRET = "browser-secret-a";

async function ask(purpose: "sign-in" | "second-factor" = "sign-in", identifier = SECRET) {
    return requestApproval({ userId: "u1", identifier, device: null, ip: null, place: null, purpose });
}

beforeEach(() => {
    rows.clear();
});

describe("passwordless phone sign-in", () => {
    it("always carries a number, and stores only a hash of the browser's secret", async () => {
        const { id, matchNumber } = await ask();
        expect(matchNumber).toBeGreaterThanOrEqual(10);
        expect(matchNumber).toBeLessThan(100);
        expect(rows.get(id)).toMatchObject({ purpose: "sign-in", matchNumber });
        expect(rows.get(id)!.challengeHash).not.toContain(SECRET);
        expect(await approvalPurpose(id)).toBe("sign-in");
    });

    it("cannot be approved without the number, or with the wrong one", async () => {
        const { id, matchNumber } = await ask();
        expect(await decideApproval("u1", id, "approve", null)).toBe("outdated");
        expect(await decideApproval("u1", id, "approve", matchNumber === 99 ? 98 : matchNumber + 1)).toBe("mismatch");
        expect(await collectSignIn(SECRET, id)).toEqual({ state: "denied", reason: "mismatch" });
    });

    it("hands the account over once, and only to the browser that asked", async () => {
        const { id, matchNumber } = await ask();
        expect(await collectSignIn(SECRET, id)).toEqual({ state: "pending" });
        expect(await decideApproval("u1", id, "approve", matchNumber)).toBe("approved");
        expect(await collectSignIn("another-browser", id)).toEqual({ state: "expired" });
        expect(await collectSignIn(SECRET, id)).toEqual({ state: "approved", userId: "u1" });
        expect(await collectSignIn(SECRET, id)).toEqual({ state: "expired" });
    });

    it("never spends an approval of one purpose as the other", async () => {
        const signIn = await ask("sign-in");
        await decideApproval("u1", signIn.id, "approve", signIn.matchNumber);
        expect(await collectApproval(SECRET, signIn.id)).toEqual({ state: "expired" });
        expect(rows.get(signIn.id)!.status).toBe("approved");

        const challenge = await ask("second-factor", "challenge-identifier");
        await decideApproval("u1", challenge.id, "approve", challenge.matchNumber);
        expect(await collectSignIn("challenge-identifier", challenge.id)).toEqual({ state: "expired" });
        expect(await collectApproval("challenge-identifier", challenge.id)).toMatchObject({ state: "approved" });
    });

    it("says so when the phone denied it", async () => {
        const { id } = await ask();
        expect(await decideApproval("u1", id, "deny")).toBe("denied");
        expect(await collectSignIn(SECRET, id)).toEqual({ state: "denied", reason: "not-me" });
    });

    it("expires a request nobody answered", async () => {
        const { id } = await ask();
        rows.get(id)!.expiresAt = new Date(Date.now() - 1);
        expect(await collectSignIn(SECRET, id)).toEqual({ state: "expired" });
    });
});
