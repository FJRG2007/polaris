/**
 * The daily pass that tells somebody a key is running out.
 *
 * The rule it has to keep is "once per step": a sweep that re-announced the
 * warning every hour would train its reader to ignore it, and one that recorded
 * the announcement before sending it would swallow the only warning there was.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    /** Null is the deployment's own key, which has no inbox of its own. */
    userId: string | null;
    name: string;
    provider: string;
    expiresAt: Date | null;
    expiryNotice: string;
}

const state = {
    rows: [] as Row[],
    admins: [{ id: "admin-1" }, { id: "admin-2" }],
    sent: [] as Array<{ userId: string; event: string; title: string }>,
    /** Set to fail the next send, to check the phase is not recorded anyway. */
    failSend: false
};

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        user: { findMany: vi.fn(async () => state.admins) },
        userModelKey: {
            findMany: vi.fn(async ({ where }: { where: { expiresAt: { lte: Date } } }) =>
                state.rows.filter((row) => row.expiresAt !== null && row.expiresAt <= where.expiresAt.lte)
            ),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: { expiryNotice: string } }) => {
                const row = state.rows.find((entry) => entry.id === where.id);
                if (row) row.expiryNotice = data.expiryNotice;
                return row;
            })
        }
    }
}));

vi.mock("@/lib/notifications/dispatch", () => ({
    notify: vi.fn(async (input: { userId: string; event: string; title: string }) => {
        if (state.failSend) throw new Error("mail is down");
        state.sent.push(input);
    })
}));

const { sweepExpiringModelKeys } = await import("@/lib/agents/model-key-expiry");

const now = new Date("2026-08-05T12:00:00.000Z");
const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);

function keyEnding(days: number, notice = "", userId: string | null = "user-1"): void {
    state.rows.push({
        id: `k${state.rows.length + 1}`,
        userId,
        name: "prod-main",
        provider: "openai",
        expiresAt: inDays(days),
        expiryNotice: notice
    });
}

beforeEach(() => {
    state.rows = [];
    state.admins = [{ id: "admin-1" }, { id: "admin-2" }];
    state.sent = [];
    state.failSend = false;
});

describe("sweepExpiringModelKeys", () => {
    it("says nothing about a key that is not near its date", async () => {
        keyEnding(30);
        await sweepExpiringModelKeys(now);
        expect(state.sent).toEqual([]);
    });

    it("warns once inside the window, and records that it did", async () => {
        keyEnding(3);
        await sweepExpiringModelKeys(now);
        expect(state.sent).toHaveLength(1);
        expect(state.sent[0]?.event).toBe("account.aiKey.expiring");
        expect(state.sent[0]?.title).toContain("prod-main");
        expect(state.rows[0]?.expiryNotice).toBe("soon");
    });

    it("does not warn twice about the same step", async () => {
        keyEnding(3);
        await sweepExpiringModelKeys(now);
        await sweepExpiringModelKeys(now);
        expect(state.sent).toHaveLength(1);
    });

    it("still speaks again when the key actually expires", async () => {
        keyEnding(-1, "soon");
        await sweepExpiringModelKeys(now);
        expect(state.sent.map((entry) => entry.event)).toEqual(["account.aiKey.expired"]);
        expect(state.rows[0]?.expiryNotice).toBe("expired");
    });

    it("says nothing more once the expiry has been announced", async () => {
        keyEnding(-5, "expired");
        await sweepExpiringModelKeys(now);
        expect(state.sent).toEqual([]);
    });

    it("tells every administrator about a key the deployment holds", async () => {
        // It belongs to no account, so there is nobody it is "yours" to. Whoever
        // opens the dashboard first is the one who can replace it.
        keyEnding(3, "", null);
        await sweepExpiringModelKeys(now);
        expect(state.sent.map((entry) => entry.userId)).toEqual(["admin-1", "admin-2"]);
        expect(state.sent[0]?.title).toContain("The deployment's");
        expect(state.rows[0]?.expiryNotice).toBe("soon");
    });

    it("does not record a warning nobody could be told", async () => {
        // A deployment with no administrator to find is one where the warning
        // has not been given yet, whatever the row would otherwise say.
        state.admins = [];
        keyEnding(3, "", null);
        await sweepExpiringModelKeys(now);
        expect(state.sent).toEqual([]);
        expect(state.rows[0]?.expiryNotice).toBe("");
    });

    it("does not record a warning it failed to send", async () => {
        // Recording first would turn one failed send into a key nobody is ever
        // told about.
        keyEnding(2);
        state.failSend = true;
        await expect(sweepExpiringModelKeys(now)).rejects.toThrow();
        expect(state.rows[0]?.expiryNotice).toBe("");
    });
});
