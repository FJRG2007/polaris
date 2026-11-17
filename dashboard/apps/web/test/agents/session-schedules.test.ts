/**
 * A repository's scheduled sessions start once per firing: two dashboard
 * processes ticking the same minute start one session between them, a schedule
 * that came due many times while Polaris was down starts one when it is back,
 * and a firing while the last session still runs is skipped and recorded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    repoId: string;
    createdById: string;
    cli: string;
    schedule: string;
    timezone: string;
    prompt: string;
    enabled: boolean;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    lastSessionId: string | null;
    lastError: string | null;
}

const store = vi.hoisted(() => ({
    rows: [] as Row[],
    runs: [] as { id: string; scheduleId: string; status: string; sessionId: string | null; error: string | null; createdAt: Date }[],
    sessionState: new Map<string, string>()
}));
const mocks = vi.hoisted(() => ({ admitSession: vi.fn(), deliverFirstPrompt: vi.fn() }));

function same(a: Date | null, b: Date | null): boolean {
    return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSessionSchedule: {
            findMany: vi.fn(async ({ where }: { where: { nextRunAt: { lte: Date } } }) =>
                store.rows
                    .filter((row) => row.enabled && row.nextRunAt && row.nextRunAt <= where.nextRunAt.lte)
                    .map((row) => ({ ...row, repo: { repoFullName: "acme/app" } }))
            ),
            updateMany: vi.fn(async ({ where, data }: { where: { id: string; nextRunAt: Date | null }; data: Partial<Row> }) => {
                const row = store.rows.find((entry) => entry.id === where.id && same(entry.nextRunAt, where.nextRunAt));
                if (!row) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            }),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const row = store.rows.find((entry) => entry.id === where.id)!;
                Object.assign(row, data);
                return row;
            })
        },
        agentSessionScheduleRun: {
            create: vi.fn(async ({ data }: { data: { scheduleId: string; status: string; sessionId: string | null; error: string | null } }) => {
                store.runs.push({ ...data, id: `run-${store.runs.length}`, createdAt: new Date() });
            }),
            findMany: vi.fn(async () => []),
            deleteMany: vi.fn()
        },
        agentSession: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                store.sessionState.has(where.id) ? { state: store.sessionState.get(where.id) } : null
            )
        }
    }
}));
vi.mock("@/lib/agents/session-queue", () => ({ admitSession: mocks.admitSession }));
vi.mock("@/lib/agents/session-runtime", () => ({ deliverFirstPrompt: mocks.deliverFirstPrompt }));
vi.mock("@/lib/agents/session-service", () => {
    class SessionRefusal extends Error {}
    return { SessionRefusal, readableFailure: () => "failed" };
});

import * as schedules from "@/lib/agents/session-schedules";

const NOW = new Date("2026-11-17T10:00:30Z");

function hourly(overrides: Partial<Row> = {}): Row {
    return {
        id: "schedule-1",
        repoId: "repo-1",
        createdById: "user-1",
        cli: "claude",
        schedule: "0 * * * *",
        timezone: "UTC",
        prompt: "Update the dependencies\nand open a pull request",
        enabled: true,
        nextRunAt: new Date("2026-11-17T10:00:00Z"),
        lastRunAt: null,
        lastSessionId: null,
        lastError: null,
        ...overrides
    };
}

beforeEach(() => {
    store.rows = [];
    store.runs = [];
    store.sessionState = new Map();
    mocks.admitSession.mockReset();
    mocks.deliverFirstPrompt.mockReset();
    let n = 0;
    mocks.admitSession.mockImplementation(async () => ({ session: { id: `session-${++n}` }, queuedAt: null }));
    mocks.deliverFirstPrompt.mockResolvedValue(undefined);
});

describe("tickSessionSchedules", () => {
    it("starts a due schedule as its owner and moves it to the next firing", async () => {
        store.rows = [hourly()];
        expect(await schedules.tickSessionSchedules(NOW)).toEqual({ started: 1, skipped: 0, failed: 0 });
        expect(mocks.admitSession).toHaveBeenCalledTimes(1);
        const [input, prompt] = mocks.admitSession.mock.calls[0]!;
        expect(input).toMatchObject({ repoId: "repo-1", startedById: "user-1", cli: "claude", place: "local", title: "Update the dependencies" });
        expect(prompt).toBe("Update the dependencies\nand open a pull request");
        expect(mocks.deliverFirstPrompt).toHaveBeenCalledWith("session-1", prompt);
        expect(store.rows[0]!.nextRunAt?.toISOString()).toBe("2026-11-17T11:00:00.000Z");
        expect(store.rows[0]!.lastSessionId).toBe("session-1");
        expect(store.runs).toEqual([expect.objectContaining({ status: "started", sessionId: "session-1" })]);
    });

    it("starts one session when two processes tick the same minute", async () => {
        store.rows = [hourly()];
        const [a, b] = await Promise.all([schedules.tickSessionSchedules(NOW), schedules.tickSessionSchedules(NOW)]);
        expect(a.started + b.started).toBe(1);
        expect(mocks.admitSession).toHaveBeenCalledTimes(1);
        expect(store.runs).toHaveLength(1);
    });

    it("starts once, not once per missed firing, after downtime", async () => {
        // Due at 06:00 and missed four times since.
        store.rows = [hourly({ nextRunAt: new Date("2026-11-17T06:00:00Z") })];
        await schedules.tickSessionSchedules(NOW);
        await schedules.tickSessionSchedules(new Date(NOW.getTime() + 1000));
        await schedules.tickSessionSchedules(new Date(NOW.getTime() + 60_000));
        expect(mocks.admitSession).toHaveBeenCalledTimes(1);
        expect(store.rows[0]!.nextRunAt?.toISOString()).toBe("2026-11-17T11:00:00.000Z");
    });

    it("skips a firing while the last session it started is still going", async () => {
        store.rows = [hourly({ lastSessionId: "session-0" })];
        store.sessionState.set("session-0", "working");
        expect(await schedules.tickSessionSchedules(NOW)).toEqual({ started: 0, skipped: 1, failed: 0 });
        expect(mocks.admitSession).not.toHaveBeenCalled();
        expect(store.runs[0]).toMatchObject({ status: "skipped", sessionId: null });
        // Still claimed: the skipped firing is not retried every minute.
        expect(store.rows[0]!.nextRunAt?.toISOString()).toBe("2026-11-17T11:00:00.000Z");
    });

    it("starts again once the last session has finished its turn or ended", async () => {
        for (const state of ["idle", "stopped", "failed"]) {
            store.rows = [hourly({ lastSessionId: "session-0" })];
            store.sessionState.set("session-0", state);
            expect((await schedules.tickSessionSchedules(NOW)).started).toBe(1);
        }
    });

    it("records a queued session without delivering the prompt itself", async () => {
        store.rows = [hourly()];
        mocks.admitSession.mockResolvedValueOnce({ session: { id: "session-9" }, queuedAt: 2 });
        await schedules.tickSessionSchedules(NOW);
        expect(mocks.deliverFirstPrompt).not.toHaveBeenCalled();
        expect(store.runs[0]).toMatchObject({ status: "queued", sessionId: "session-9" });
    });

    it("records a refused start and keeps the schedule", async () => {
        store.rows = [hourly()];
        mocks.admitSession.mockRejectedValueOnce(new Error("socket closed"));
        expect((await schedules.tickSessionSchedules(NOW)).failed).toBe(1);
        expect(store.runs[0]).toMatchObject({ status: "failed", error: "failed" });
        expect(store.rows[0]!.enabled).toBe(true);
        expect(store.rows[0]!.lastError).toBe("failed");
    });

    it("leaves a schedule that is not due alone", async () => {
        store.rows = [hourly({ nextRunAt: new Date("2026-11-17T11:00:00Z") })];
        expect((await schedules.tickSessionSchedules(NOW)).started).toBe(0);
        expect(mocks.admitSession).not.toHaveBeenCalled();
    });
});

describe("schedule input", () => {
    const valid = { repoId: "0190a3b2-6d8e-7c1a-9b2f-3e4d5c6b7a80", cli: "claude", schedule: "0 9 * * 1", timezone: "Europe/Madrid", prompt: "  Triage new issues  " };

    it("accepts a schedule and trims the prompt", () => {
        const parsed = schedules.sessionScheduleInputSchema.parse(valid);
        expect(parsed.prompt).toBe("Triage new issues");
        expect(parsed.enabled).toBe(true);
    });

    it("refuses an empty prompt, a bad cron, an unknown zone and an unknown agent", () => {
        for (const bad of [{ prompt: "   " }, { schedule: "every day" }, { timezone: "Mars/Olympus" }, { cli: "nope" }]) {
            expect(schedules.sessionScheduleInputSchema.safeParse({ ...valid, ...bad }).success).toBe(false);
        }
    });

    it("reads the next firing in the schedule's own zone", () => {
        const next = schedules.nextFiring("0 9 * * 1", "Europe/Madrid", true, NOW);
        // Monday 9:00 in Madrid (UTC+1 in November).
        expect(next?.toISOString()).toBe("2026-11-23T08:00:00.000Z");
        expect(schedules.nextFiring("0 9 * * 1", "UTC", false, NOW)).toBeNull();
    });
});
