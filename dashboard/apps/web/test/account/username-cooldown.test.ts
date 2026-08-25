/**
 * The wait between handle changes, where it is actually enforced.
 *
 * The rule itself is a pure function tested in @polaris/core. What is under test
 * here is the part that can be got around: which edits count as a change, and
 * whether the clock is started by all of them.
 *
 * The one that matters is clearing. If dropping a handle were free, then clear
 * and set is two changes for the price of none, and the wait stops meaning
 * anything at all - which is the whole point of it. Retyping the same handle in
 * different capitals is the opposite mistake: charging somebody a month for
 * pressing Save on a form that sends every field is a bug, not a policy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    username: string | null;
    usernameChangedAt: Date | null;
}

let rows: Row[] = [];
const writes: Array<{ id: string; data: Record<string, unknown> }> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                rows.find((row) => row.id === where.id) ?? null,
            findFirst: async ({ where }: { where: { username: string; id: { not: string } } }) =>
                rows.find((row) => row.username === where.username && row.id !== where.id.not) ?? null,
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                writes.push({ id: where.id, data });
                const row = rows.find((candidate) => candidate.id === where.id);
                if (row && "username" in data) row.username = data.username as string | null;
                return row;
            }
        },
        account: { findFirst: async () => null }
    }
}));

const { updateUserProfile } = await import("@polaris/auth");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-24T12:00:00.000Z");

beforeEach(() => {
    rows = [{ id: "ana", username: "ana", usernameChangedAt: null }];
    writes.length = 0;
});

describe("an account that has never changed its handle", () => {
    it("may take a new one", async () => {
        const result = await updateUserProfile("ana", { username: "anaR" }, { now: NOW });
        expect(result.error).toBeUndefined();
        expect(writes[0]?.data.username).toBe("anar");
    });

    it("starts the clock when it does", async () => {
        await updateUserProfile("ana", { username: "anaR" }, { now: NOW });
        expect(writes[0]?.data.usernameChangedAt).toEqual(NOW);
    });
});

describe("an account that changed it recently", () => {
    beforeEach(() => {
        rows = [{ id: "ana", username: "ana", usernameChangedAt: new Date(NOW.getTime() - DAY) }];
    });

    it("is refused, and told when it may", async () => {
        const result = await updateUserProfile("ana", { username: "anaR" }, { now: NOW });
        expect(result.error).toContain("29 days");
        expect(writes).toHaveLength(0);
    });

    it("may still change everything else about the profile", async () => {
        // The wait is on the handle. Locking somebody out of their own display
        // name for a month because they renamed once would be a different rule.
        const result = await updateUserProfile("ana", { name: "Ana R" }, { now: NOW });
        expect(result.error).toBeUndefined();
        expect(writes[0]?.data.name).toBe("Ana R");
    });

    it("may press Save on a form that sends the handle it already has", async () => {
        // Every field goes up on every save, so an unchanged handle must not read
        // as an attempt to change one.
        const result = await updateUserProfile("ana", { username: "ana", name: "Ana R" }, { now: NOW });
        expect(result.error).toBeUndefined();
    });

    it("is not charged for retyping the same handle in different capitals", async () => {
        const result = await updateUserProfile("ana", { username: "ANA" }, { now: NOW });
        expect(result.error).toBeUndefined();
        // And nothing was written for it either.
        expect(writes[0]?.data.usernameChangedAt).toBeUndefined();
    });
});

describe("clearing a handle", () => {
    it("counts as a change and starts the clock", async () => {
        // Otherwise clear-then-set is two changes for the price of none.
        await updateUserProfile("ana", { username: "" }, { now: NOW });
        expect(writes[0]?.data.username).toBeNull();
        expect(writes[0]?.data.usernameChangedAt).toEqual(NOW);
    });

    it("leaves the account unable to immediately take a new one", async () => {
        rows = [{ id: "ana", username: null, usernameChangedAt: NOW }];
        const result = await updateUserProfile("ana", { username: "somebodyelse" }, { now: NOW });
        expect(result.error).toContain("30 days");
    });
});

describe("the operator's own wait", () => {
    beforeEach(() => {
        rows = [{ id: "ana", username: "ana", usernameChangedAt: new Date(NOW.getTime() - 2 * DAY) }];
    });

    it("is honoured when it is shorter than the default", async () => {
        const result = await updateUserProfile("ana", { username: "anaR" }, { now: NOW, cooldownDays: 1 });
        expect(result.error).toBeUndefined();
    });

    it("lets a deployment turn the wait off entirely", async () => {
        rows = [{ id: "ana", username: "ana", usernameChangedAt: NOW }];
        const result = await updateUserProfile("ana", { username: "anaR" }, { now: NOW, cooldownDays: 0 });
        expect(result.error).toBeUndefined();
    });

    it("applies the default when the caller says nothing, rather than no rule", async () => {
        rows = [{ id: "ana", username: "ana", usernameChangedAt: NOW }];
        // With no clock passed the rule reads the real one, and what it reports is
        // how much of the wait is LEFT - so this said "30 days" on the day it was
        // written and "29 days" the morning after, failing for the calendar rather
        // than for the code. Only Date is faked: faking the timers as well would
        // hang anything inside that waits on one.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
        try {
            const result = await updateUserProfile("ana", { username: "anaR" });
            expect(result.error).toContain("30 days");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the checks that already existed", () => {
    it("still refuses a handle somebody else holds", async () => {
        rows = [
            { id: "ana", username: "ana", usernameChangedAt: null },
            { id: "bruno", username: "taken", usernameChangedAt: null }
        ];
        const result = await updateUserProfile("ana", { username: "taken" }, { now: NOW });
        expect(result.error).toContain("already taken");
        expect(writes).toHaveLength(0);
    });

    it("still refuses a handle of the wrong shape", async () => {
        const result = await updateUserProfile("ana", { username: "no spaces" }, { now: NOW });
        expect(result.error).toContain("3-32 characters");
    });

    it("checks the wait before the shape, so a refused account is not told its idea was also invalid", async () => {
        rows = [{ id: "ana", username: "ana", usernameChangedAt: NOW }];
        const result = await updateUserProfile("ana", { username: "no spaces" }, { now: NOW });
        expect(result.error).toContain("30 days");
    });
});
