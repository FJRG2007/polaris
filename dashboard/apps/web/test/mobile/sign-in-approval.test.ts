/**
 * Number matching on "Is this you?": the phone is offered three numbers with the
 * right one among them, only the right one approves, a wrong one denies and is
 * counted, and an old phone app that sends no number cannot approve at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
    id: string;
    userId: string;
    status: string;
    matchNumber: number | null;
    reason: string | null;
    expiresAt: Date;
    decidedAt: Date | null;
};

const rows = new Map<string, Row>();
let deviceKey: { id: string } | null = { id: "k1" };

function live(where: { id?: string; userId?: string; status?: string }): Row | undefined {
    const row = where.id ? rows.get(where.id) : undefined;
    if (!row || row.userId !== where.userId || row.status !== where.status) return undefined;
    return row.expiresAt > new Date() ? row : undefined;
}

vi.mock("@polaris/auth", () => ({ noteSecondFactor: async () => undefined }));
vi.mock("@polaris/db", () => ({
    prisma: {
        mobileDeviceKey: { findFirst: async () => deviceKey },
        signInApproval: {
            findFirst: async ({ where }: { where: Row }) => live(where) ?? null,
            updateMany: async ({ where, data }: { where: Row; data: Partial<Row> }) => {
                const row = live(where);
                if (!row) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            },
            count: async ({ where }: { where: { userId: string; reason: string; decidedAt: { gt: Date } } }) =>
                [...rows.values()].filter(
                    (row) =>
                        row.userId === where.userId &&
                        row.reason === where.reason &&
                        row.decidedAt !== null &&
                        row.decidedAt > where.decidedAt.gt
                ).length
        }
    }
}));

const { decideApproval, matchChoices, phoneCanApprove, MISMATCH_LIMIT } = await import(
    "@/lib/mobile/sign-in-approval"
);

function seed(id: string, matchNumber: number | null): void {
    rows.set(id, {
        id,
        userId: "u1",
        status: "pending",
        matchNumber,
        reason: null,
        expiresAt: new Date(Date.now() + 60_000),
        decidedAt: null
    });
}

const ID = "0190a3b2-0000-7000-8000-000000000001";

beforeEach(() => {
    rows.clear();
    deviceKey = { id: "k1" };
});

describe("matchChoices", () => {
    it("offers three distinct two-digit numbers, the right one among them, the same every time", () => {
        for (let number = 10; number < 100; number += 7) {
            const id = `0190a3b2-0000-7000-8000-0000000000${number}`;
            const choices = matchChoices(id, number);
            expect(choices).toHaveLength(3);
            expect(new Set(choices).size).toBe(3);
            expect(choices).toContain(number);
            for (const choice of choices) expect(choice >= 10 && choice <= 99).toBe(true);
            expect(matchChoices(id, number)).toEqual(choices);
        }
    });

    it("does not always put the right number in the same place", () => {
        const places = new Set<number>();
        for (let index = 0; index < 30; index += 1) {
            const id = `0190a3b2-0000-7000-8000-${String(index).padStart(12, "0")}`;
            places.add(matchChoices(id, 42).indexOf(42));
        }
        expect(places.size).toBe(3);
    });
});

describe("decideApproval", () => {
    it("approves with the right number", async () => {
        seed(ID, 42);
        expect(await decideApproval("u1", ID, "approve", 42)).toBe("approved");
        expect(rows.get(ID)).toMatchObject({ status: "approved", reason: null });
    });

    it("denies a wrong number and records it as a mismatch", async () => {
        seed(ID, 42);
        expect(await decideApproval("u1", ID, "approve", 17)).toBe("mismatch");
        expect(rows.get(ID)).toMatchObject({ status: "denied", reason: "mismatch" });
    });

    it("leaves a numbered request untouched when an old app approves without a number", async () => {
        seed(ID, 42);
        expect(await decideApproval("u1", ID, "approve", null)).toBe("outdated");
        expect(rows.get(ID)?.status).toBe("pending");
        expect(await decideApproval("u1", ID, "deny")).toBe("denied");
        expect(rows.get(ID)).toMatchObject({ status: "denied", reason: "not-me" });
    });

    it("still approves a request made before number matching", async () => {
        seed(ID, null);
        expect(await decideApproval("u1", ID, "approve", null)).toBe("approved");
    });

    it("answers gone for somebody else's request, an expired one, or a second answer", async () => {
        seed(ID, 42);
        expect(await decideApproval("u2", ID, "approve", 42)).toBe("gone");
        expect(await decideApproval("u1", ID, "approve", 42)).toBe("approved");
        expect(await decideApproval("u1", ID, "deny")).toBe("gone");
        seed(ID, 42);
        rows.get(ID)!.expiresAt = new Date(Date.now() - 1);
        expect(await decideApproval("u1", ID, "approve", 42)).toBe("gone");
    });
});

describe("phoneCanApprove", () => {
    it("needs a registered phone", async () => {
        deviceKey = null;
        expect(await phoneCanApprove("u1")).toBe(false);
    });

    it("rests after too many wrong numbers in the hour", async () => {
        for (let index = 0; index < MISMATCH_LIMIT; index += 1) {
            const id = `0190a3b2-0000-7000-8000-00000000010${index}`;
            seed(id, 42);
            expect(await phoneCanApprove("u1")).toBe(true);
            await decideApproval("u1", id, "approve", 11);
        }
        expect(await phoneCanApprove("u1")).toBe(false);
    });
});
