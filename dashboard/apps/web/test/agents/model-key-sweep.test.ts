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
    userId: string;
    name: string;
    provider: string;
    expiresAt: Date | null;
    expiryNotice: string;
}

const state = {
    rows: [] as Row[],
    sent: [] as Array<{ userId: string; event: string; title: string }>,
    /** Set to fail the next send, to check the phase is not recorded anyway. */
    failSend: false
};

vi.mock("@polaris/db", () => ({
    prisma: {
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

function keyEnding(days: number, notice = ""): void {
    state.rows.push({
        id: `k${state.rows.length + 1}`,
        userId: "user-1",
        name: "prod-main",
        provider: "openai",
        expiresAt: inDays(days),
        expiryNotice: notice
    });
}

beforeEach(() => {
    state.rows = [];
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

    it("does not record a warning it failed to send", async () => {
        // Recording first would turn one failed send into a key nobody is ever
        // told about.
        keyEnding(2);
        state.failSend = true;
        await expect(sweepExpiringModelKeys(now)).rejects.toThrow();
        expect(state.rows[0]?.expiryNotice).toBe("");
    });
});
