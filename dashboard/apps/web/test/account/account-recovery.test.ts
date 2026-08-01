/**
 * The last way into an account.
 *
 * Three properties carry this route and none of them is visible from the happy
 * path. The first is that it says the same thing whatever the identifier turned
 * out to be, so it cannot be swept for registered addresses. The second is that
 * answering the recovery questions raises a request rather than granting one -
 * they are low-entropy secrets answered from outside any session, and treating
 * them as proof would make them a second, weaker password. The third is that a
 * ticket is spent exactly once: an approved request that has already been
 * redeemed is not a standing key to the account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface RecoveryRow {
    id: string;
    userId: string;
    tokenHash: string;
    verified: boolean;
    status: string;
    requestIp: string | null;
    decidedById: string | null;
    decidedAt: Date | null;
    expiresAt: Date;
    createdAt: Date;
}

const users = [
    { id: "user-1", email: "ada@example.com", username: "ada", name: "Ada Lovelace", bannedAt: null as Date | null },
    { id: "user-2", email: "banned@example.com", username: "gone", name: "Gone Away", bannedAt: new Date() }
];

let rows: RecoveryRow[] = [];
let nextId = 1;

/** Answers that verify, keyed by user. Anything else fails the check. */
const correctAnswers: Record<string, string[]> = { "user-1": ["blue", "paris", "ada"] };

const notify = vi.fn(async () => {});
const resetPassword = vi.fn(async () => ({}) as { error?: string });
const revokeSessions = vi.fn(async () => ({}));
let breached = false;

function matches(row: RecoveryRow, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
        const actual = row[key as keyof RecoveryRow];
        if (value !== null && typeof value === "object") {
            const clause = value as { not?: unknown; gt?: Date };
            if ("not" in clause && actual === clause.not) return false;
            if (clause.gt && !((actual as Date) > clause.gt)) return false;
            continue;
        }
        if (actual !== value) return false;
    }
    return true;
}

const accountRecovery = {
    findUnique: vi.fn(async ({ where }: { where: { tokenHash?: string; id?: string } }) =>
        rows.find((row) => (where.tokenHash ? row.tokenHash === where.tokenHash : row.id === where.id)) ?? null
    ),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)).map((row) => ({ ...row, user: users.find((u) => u.id === row.userId) }))
    ),
    create: vi.fn(async ({ data }: { data: Partial<RecoveryRow> }) => {
        const row: RecoveryRow = {
            id: `req-${nextId++}`,
            status: "pending",
            verified: false,
            requestIp: null,
            decidedById: null,
            decidedAt: null,
            createdAt: new Date(),
            ...(data as RecoveryRow)
        };
        rows.push(row);
        return row;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = rows.length;
        rows = rows.filter((row) => !matches(row, where));
        return { count: before - rows.length };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RecoveryRow> }) => {
        const row = rows.find((entry) => entry.id === where.id);
        if (row) Object.assign(row, data);
        return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<RecoveryRow> }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
    })
};

vi.mock("@polaris/db", () => ({
    prisma: {
        accountRecovery,
        user: {
            findFirst: vi.fn(async ({ where }: { where: { email?: string; username?: string } }) =>
                users.find((user) => (where.email ? user.email === where.email : user.username === where.username)) ?? null
            ),
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                users.find((user) => user.id === where.id) ?? null
            )
        },
        $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
    }
}));

vi.mock("@polaris/auth", () => ({
    listSecurityQuestions: async (userId: string) =>
        (correctAnswers[userId] ?? []).map((_, index) => ({ id: `q-${index}`, question: `Question ${index + 1}?` })),
    verifySecurityAnswers: async (_auth: unknown, userId: string, answers: string[]) => {
        const expected = correctAnswers[userId];
        return Boolean(expected) && expected.every((answer, index) => answer === answers[index]);
    },
    resetUserPassword: (...args: unknown[]) => resetPassword(...(args as [])),
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => {} }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
vi.mock("@/lib/notifications/operators", () => ({ notifyOperators: (input: unknown) => notify(input as never) }));
vi.mock("@/lib/user-admin-service", () => ({ revokeUserSessions: (...args: unknown[]) => revokeSessions(...(args as [])) }));
vi.mock("@/lib/pwned-passwords", () => ({ passwordIsBreached: async () => breached }));

const {
    accountRecoveryQuestions,
    accountRecoveryStatus,
    completeAccountRecovery,
    decideRecoveryRequest,
    listRecoveryRequests,
    requestAccountRecovery
} = await import("../../src/lib/account-recovery-service");

/** A fresh password nothing in the fixtures resembles. */
const NEW_PASSWORD = "quiet-lantern-drift-92";

async function raise(identifier: string, answers: string[] = []) {
    return requestAccountRecovery({ identifier, answers, ip: "203.0.113.7", userAgent: "test" });
}

beforeEach(() => {
    rows = [];
    nextId = 1;
    breached = false;
    notify.mockClear();
    revokeSessions.mockClear();
    resetPassword.mockClear();
    resetPassword.mockResolvedValue({});
});

describe("finding out what to answer", () => {
    it("returns the questions the account set", async () => {
        const result = await accountRecoveryQuestions("ada@example.com", "203.0.113.7");
        expect(result.questions).toHaveLength(3);
    });

    it("answers an unknown address exactly like an account with no questions", async () => {
        const unknown = await accountRecoveryQuestions("nobody@example.com", "203.0.113.7");
        const banned = await accountRecoveryQuestions("banned@example.com", "203.0.113.7");
        expect(unknown.questions).toEqual([]);
        expect(banned.questions).toEqual([]);
    });

    it("takes a username as readily as an address", async () => {
        expect((await accountRecoveryQuestions("ada", "203.0.113.7")).questions).toHaveLength(3);
    });
});

describe("raising a request", () => {
    it("hands back a ticket for an address that matches nothing, and tells nobody", async () => {
        const result = await raise("nobody@example.com");
        expect(result.ticket).not.toBe("");
        expect(rows).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
    });

    it("records that the questions were answered, and says so to the administrators", async () => {
        await raise("ada@example.com", ["blue", "paris", "ada"]);
        expect(rows[0]?.verified).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[0]).toMatchObject({ event: "account.recovery", actionRequired: true });
    });

    it("still raises the request when nothing could be verified", async () => {
        await raise("ada@example.com", ["red", "berlin", "eve"]);
        expect(rows[0]?.verified).toBe(false);
        expect(rows[0]?.status).toBe("pending");
    });

    it("replaces the one still waiting rather than queueing another", async () => {
        const first = await raise("ada@example.com");
        await raise("ada@example.com");
        expect(rows).toHaveLength(1);
        expect(await accountRecoveryStatus(first.ticket)).toBe("pending");
        expect(await listRecoveryRequests()).toHaveLength(1);
    });

    it("leaves an approved request alone, so nobody can take back a decision", async () => {
        // Otherwise knowing somebody's address is enough to keep them locked out:
        // raise a request of your own and their approved ticket dies with it.
        const approved = await raise("ada@example.com", ["blue", "paris", "ada"]);
        await decideRecoveryRequest("admin-1", rows[0]!.id, true);
        await raise("ada@example.com");

        expect(await accountRecoveryStatus(approved.ticket)).toBe("approved");
        expect(await completeAccountRecovery(approved.ticket, NEW_PASSWORD)).toEqual({});
    });
});

describe("redeeming a request", () => {
    it("refuses while nobody has decided it", async () => {
        const { ticket } = await raise("ada@example.com", ["blue", "paris", "ada"]);
        expect(await accountRecoveryStatus(ticket)).toBe("pending");
        expect(await completeAccountRecovery(ticket, NEW_PASSWORD)).toMatchObject({
            error: expect.stringContaining("not approved")
        });
        expect(resetPassword).not.toHaveBeenCalled();
    });

    it("refuses a request that was turned down", async () => {
        const { ticket } = await raise("ada@example.com");
        await decideRecoveryRequest("admin-1", rows[0]!.id, false);
        expect(await accountRecoveryStatus(ticket)).toBe("denied");
        expect(await completeAccountRecovery(ticket, NEW_PASSWORD)).toHaveProperty("error");
    });

    it("sets the password once approved, and ends every session on the account", async () => {
        const { ticket } = await raise("ada@example.com", ["blue", "paris", "ada"]);
        await decideRecoveryRequest("admin-1", rows[0]!.id, true);
        expect(await accountRecoveryStatus(ticket)).toBe("approved");

        expect(await completeAccountRecovery(ticket, NEW_PASSWORD)).toEqual({});
        expect(revokeSessions).toHaveBeenCalledWith("user-1", "user-1");
        expect(await accountRecoveryStatus(ticket)).toBe("used");
    });

    it("spends the ticket, so the same link cannot be used twice", async () => {
        const { ticket } = await raise("ada@example.com");
        await decideRecoveryRequest("admin-1", rows[0]!.id, true);
        await completeAccountRecovery(ticket, NEW_PASSWORD);
        expect(await completeAccountRecovery(ticket, "another-unrelated-one")).toHaveProperty("error");
        expect(resetPassword).toHaveBeenCalledTimes(1);
    });

    it("refuses a request whose ticket ran out of time", async () => {
        const { ticket } = await raise("ada@example.com");
        await decideRecoveryRequest("admin-1", rows[0]!.id, true);
        rows[0]!.expiresAt = new Date(Date.now() - 1000);
        expect(await completeAccountRecovery(ticket, NEW_PASSWORD)).toMatchObject({
            error: expect.stringContaining("expired")
        });
        expect(resetPassword).not.toHaveBeenCalled();
    });

    it("refuses a password built out of the account, and one already in a breach", async () => {
        const { ticket } = await raise("ada@example.com");
        await decideRecoveryRequest("admin-1", rows[0]!.id, true);

        expect(await completeAccountRecovery(ticket, "AdaLovelace2026")).toMatchObject({
            error: expect.stringContaining("too close")
        });
        breached = true;
        expect(await completeAccountRecovery(ticket, NEW_PASSWORD)).toMatchObject({
            error: expect.stringContaining("data breach")
        });
        expect(resetPassword).not.toHaveBeenCalled();
    });

    it("reads an unknown ticket as pending rather than as an error", async () => {
        expect(await accountRecoveryStatus("not-a-real-ticket")).toBe("pending");
    });
});

describe("the administrators' list", () => {
    it("carries only what is still waiting, and only decides it once", async () => {
        await raise("ada@example.com", ["blue", "paris", "ada"]);
        expect(await listRecoveryRequests()).toHaveLength(1);

        const id = rows[0]!.id;
        expect(await decideRecoveryRequest("admin-1", id, true)).toEqual({});
        expect(await decideRecoveryRequest("admin-1", id, false)).toMatchObject({
            error: expect.stringContaining("already been decided")
        });
        expect(await listRecoveryRequests()).toHaveLength(0);
    });
});
