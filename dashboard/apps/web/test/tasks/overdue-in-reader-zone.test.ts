import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The home headline and the "my work" card are counted on the server, whose
 * clock is UTC. An all-day task due today is stored as the reader's local
 * midnight, so the day boundary has to be the reader's or the task is overdue
 * from one in the morning in Madrid. Every instant here is written in UTC.
 */

const state = vi.hoisted(() => ({
    zone: "Europe/Madrid",
    counts: [] as unknown[],
    rows: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        task: {
            count: vi.fn(async (args: { where: Record<string, unknown> }) => {
                state.counts.push(args.where);
                return 0;
            }),
            findMany: vi.fn(async () => state.rows)
        }
    }
}));
vi.mock("@/lib/display-prefs-service", () => ({
    resolveDisplayPreferencesFor: vi.fn(async () => ({ timeZone: state.zone }))
}));
vi.mock("@/lib/tasks/access", () => ({
    scopeSpaceIds: () => ["space-1"],
    scopeTaskWhere: () => ({ spaceId: { in: ["space-1"] } })
}));

const { myUrgentTasks, myWorkCounts } = await import("@/lib/tasks/report-service");

const scope = { spaceIds: ["space-1"], listIds: [] } as never;

/** An all-day task due 26 Oct, picked in whichever zone it was stored from. */
function dueRow(dueDate: string) {
    return {
        id: "task-1",
        name: "Fixture task",
        number: 1,
        priority: "none",
        dueDate: new Date(dueDate),
        spaceId: "space-1",
        statusId: null,
        list: { name: "Fixture list" },
        space: { prefix: "FIX" }
    };
}

/** The `dueDate` bounds the headline counted overdue and due today against. */
async function bounds(now: string) {
    state.counts = [];
    await myWorkCounts("user-1", scope, new Date(now));
    const [, overdue, today] = state.counts as { dueDate: { lt?: Date; gte?: Date; lte?: Date } }[];
    return { overdueBefore: overdue!.dueDate.lt!, todayFrom: today!.dueDate.gte!, todayTo: today!.dueDate.lte! };
}

describe("tasks due today, counted on a UTC server", () => {
    beforeEach(() => {
        state.zone = "Europe/Madrid";
        state.rows = [];
    });

    it("counts a Madrid all-day task as due today, not overdue, at 10:00 local", async () => {
        const due = new Date("2026-10-25T23:00:00Z");
        const { overdueBefore, todayFrom, todayTo } = await bounds("2026-10-26T09:00:00Z");
        expect(due < overdueBefore).toBe(false);
        expect(due >= todayFrom && due <= todayTo).toBe(true);
    });

    it("still today at 23:30 local, overdue at 00:30 the next day", async () => {
        const due = new Date("2026-10-25T23:00:00Z");
        const late = await bounds("2026-10-26T22:30:00Z");
        expect(due < late.overdueBefore).toBe(false);
        const next = await bounds("2026-10-26T23:30:00Z");
        expect(due < next.overdueBefore).toBe(true);
    });

    it("does the same west of UTC, in New York", async () => {
        state.zone = "America/New_York";
        const due = new Date("2026-10-26T04:00:00Z");
        expect(due < (await bounds("2026-10-26T14:00:00Z")).overdueBefore).toBe(false);
        expect(due < (await bounds("2026-10-27T03:30:00Z")).overdueBefore).toBe(false);
        expect(due < (await bounds("2026-10-27T04:30:00Z")).overdueBefore).toBe(true);
    });

    it("flags the my-work card the same way the counts do", async () => {
        state.rows = [dueRow("2026-10-25T23:00:00Z")];
        const [morning] = await myUrgentTasks("user-1", scope, 5, new Date("2026-10-26T09:00:00Z"));
        expect(morning?.overdue).toBe(false);
        const [after] = await myUrgentTasks("user-1", scope, 5, new Date("2026-10-26T23:30:00Z"));
        expect(after?.overdue).toBe(true);
    });
});
