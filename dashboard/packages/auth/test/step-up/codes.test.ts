/**
 * The short-lived codes that re-prove an open session.
 *
 * Six digits is a million guesses, which is nothing to a script and everything
 * to a person - so the properties pinned here are the ones that make a short
 * secret safe: a code works once, a wrong one costs a guess, the budget is
 * finite and spending it kills the code, an expired one is refused, and a code
 * minted for one act cannot be spent on another.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** One in-memory Verification table, keyed the way Prisma finds rows. */
interface Row {
    id: string;
    identifier: string;
    value: string;
    expiresAt: Date;
    createdAt: Date;
}

let rows: Row[] = [];
let nextId = 1;

const verification = {
    create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
        const row: Row = { id: `v${nextId++}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: { identifier: string } }) => {
        const found = rows.filter((row) => row.identifier === where.identifier);
        return found[found.length - 1] ?? null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: { value: string } }) => {
        const row = rows.find((entry) => entry.id === where.id);
        if (row) row.value = data.value;
        return row;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows = rows.filter((row) => row.id !== where.id);
        return null;
    }),
    deleteMany: vi.fn(async ({ where }: { where: { identifier: string } }) => {
        const before = rows.length;
        rows = rows.filter((row) => row.identifier !== where.identifier);
        return { count: before - rows.length };
    })
};

vi.mock("@polaris/db", () => ({ prisma: { verification } }));

/** The password hasher better-auth would give us, reduced to what these use. */
const auth = {
    $context: Promise.resolve({
        password: {
            hash: async (value: string) => `hashed:${value}`,
            verify: async ({ hash, password }: { hash: string; password: string }) => hash === `hashed:${password}`
        }
    })
} as unknown as import("../../src/auth.js").Auth;

const { discardStepUpCode, issueStepUpCode, verifyStepUpCode } = await import("../../src/step-up.js");

beforeEach(() => {
    rows = [];
    nextId = 1;
    vi.clearAllMocks();
});

describe("a step-up code", () => {
    it("is six digits, and works once", async () => {
        const code = await issueStepUpCode(auth, "u1", "org-delete:o1");
        expect(code).toMatch(/^\d{6}$/);

        expect(await verifyStepUpCode(auth, "u1", "org-delete:o1", code)).toEqual({});
        // Spent: the same code a second time has nothing left to check against.
        expect((await verifyStepUpCode(auth, "u1", "org-delete:o1", code)).error).toBeTruthy();
    });

    it("cannot be spent on a different act", async () => {
        const code = await issueStepUpCode(auth, "u1", "org-delete:o1");
        expect((await verifyStepUpCode(auth, "u1", "org-delete:o2", code)).error).toBeTruthy();
        // And is still good for the one it was minted for.
        expect(await verifyStepUpCode(auth, "u1", "org-delete:o1", code)).toEqual({});
    });

    it("cannot be spent by a different account", async () => {
        const code = await issueStepUpCode(auth, "u1", "org-delete:o1");
        expect((await verifyStepUpCode(auth, "u2", "org-delete:o1", code)).error).toBeTruthy();
    });

    it("dies once the guesses are spent, rather than being walked through", async () => {
        const code = await issueStepUpCode(auth, "u1", "org-delete:o1");
        for (let attempt = 0; attempt < 5; attempt += 1) {
            expect((await verifyStepUpCode(auth, "u1", "org-delete:o1", "000000")).error).toBeTruthy();
        }
        // Right code, no budget left: refused, and the row is gone.
        expect((await verifyStepUpCode(auth, "u1", "org-delete:o1", code)).error).toBeTruthy();
        expect(rows).toHaveLength(0);
    });

    it("is refused once it has expired", async () => {
        const code = await issueStepUpCode(auth, "u1", "org-delete:o1");
        rows[0]!.expiresAt = new Date(Date.now() - 1000);
        const result = await verifyStepUpCode(auth, "u1", "org-delete:o1", code);
        expect(result.error).toContain("expired");
        expect(rows).toHaveLength(0);
    });

    it("is replaced rather than added to when another is asked for", async () => {
        const first = await issueStepUpCode(auth, "u1", "org-delete:o1");
        const second = await issueStepUpCode(auth, "u1", "org-delete:o1");
        expect(rows).toHaveLength(1);
        expect((await verifyStepUpCode(auth, "u1", "org-delete:o1", first)).error).toBeTruthy();
        expect(await verifyStepUpCode(auth, "u1", "org-delete:o1", second)).toEqual({});
    });

    it("is dropped when the confirmation is walked away from", async () => {
        const code = await issueStepUpCode(auth, "u1", "org-delete:o1");
        await discardStepUpCode("u1", "org-delete:o1");
        expect((await verifyStepUpCode(auth, "u1", "org-delete:o1", code)).error).toBeTruthy();
    });

    it("says to ask for one when none was ever minted", async () => {
        const result = await verifyStepUpCode(auth, "u1", "org-delete:o1", "123456");
        expect(result.error).toContain("Ask for a code");
    });
});
