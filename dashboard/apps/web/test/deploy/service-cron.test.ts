/**
 * Scheduled jobs run once per firing, never pile up, and retry as asked.
 *
 * Pinned here because each failure is quiet: a firing claimed by two processes
 * runs a cleanup twice, a slow job started again every minute fills a container
 * with copies of itself, and a retry that never comes looks exactly like a job
 * that succeeded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface CronRow {
    id: string;
    applicationId: string;
    name: string;
    schedule: string;
    timezone: string;
    command: string;
    timeoutSeconds: number;
    maxAttempts: number;
    retryDelaySeconds: number;
    enabled: boolean;
    nextRunAt: Date | null;
    retryAt: Date | null;
    retryAttempt: number;
    lastRunAt: Date | null;
    lastStatus: string | null;
}

interface RunRow {
    id: string;
    cronId: string;
    trigger: string;
    attempt: number;
    status: string;
    exitCode: number | null;
    output: string;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
}

let crons: CronRow[] = [];
let runs: RunRow[] = [];
let appRunning = true;
let commandCode = 0;
const notified: string[] = [];

const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, wanted]) => {
        const value = row[key];
        if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
            const cond = wanted as { lte?: Date; gt?: Date };
            if (cond.lte) return value instanceof Date && value <= cond.lte;
            if (cond.gt) return value instanceof Date && value > cond.gt;
        }
        if (wanted instanceof Date) return value instanceof Date && value.getTime() === wanted.getTime();
        return value === wanted;
    });

vi.mock("@polaris/db", () => ({
    prisma: {
        serviceCron: {
            findMany: async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
                crons.filter((row) => where.OR.some((one) => matches(row as never, one))),
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<CronRow> }) => {
                const hit = crons.filter((row) => matches(row as never, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<CronRow> }) => {
                const row = crons.find((one) => one.id === where.id)!;
                Object.assign(row, data);
                return row;
            }
        },
        serviceCronRun: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                runs.find((row) => matches(row as never, where)) ?? null,
            findMany: async () => [],
            deleteMany: async () => ({ count: 0 }),
            create: async ({ data }: { data: Partial<RunRow> }) => {
                const row: RunRow = {
                    id: `r${runs.length + 1}`,
                    cronId: data.cronId!,
                    trigger: data.trigger!,
                    attempt: data.attempt ?? 1,
                    status: data.status ?? "running",
                    exitCode: null,
                    output: "",
                    error: data.error ?? null,
                    startedAt: new Date(),
                    finishedAt: data.finishedAt ?? null
                };
                runs.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
                const row = runs.find((one) => one.id === where.id)!;
                Object.assign(row, data);
                return row;
            },
            findUnique: async ({ where }: { where: { id: string } }) => {
                const run = runs.find((one) => one.id === where.id);
                if (!run) return null;
                const cron = crons.find((one) => one.id === run.cronId)!;
                return {
                    ...run,
                    cron: {
                        ...cron,
                        application: {
                            id: "app1",
                            name: "web",
                            slug: "web",
                            currentDeploymentId: appRunning ? "d1" : null,
                            desiredState: "running",
                            target: { kind: "local" },
                            environment: { project: { id: "p1", name: "Shop", slug: "shop", ownerId: "u1" } }
                        }
                    }
                };
            }
        }
    }
}));

vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: async () => ({
        runIn: async () => ({ code: commandCode, output: commandCode === 0 ? "done\n" : "boom\n" }),
        dispose: async () => undefined
    })
}));
vi.mock("@/lib/deploy/releases", () => ({ currentReleaseRef: async () => ({ name: "shop-web-1a2b" }) }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { title: string }) => {
        notified.push(input.title);
    }
}));

const { tickServiceCrons } = await import("@/lib/deploy/service-cron");

/** Let the background run started by a tick finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function cron(over: Partial<CronRow> = {}): CronRow {
    return {
        id: "c1",
        applicationId: "app1",
        name: "cleanup",
        schedule: "*/5 * * * *",
        timezone: "UTC",
        command: "echo done",
        timeoutSeconds: 60,
        maxAttempts: 1,
        retryDelaySeconds: 30,
        enabled: true,
        nextRunAt: new Date("2026-09-10T10:00:00Z"),
        retryAt: null,
        retryAttempt: 0,
        lastRunAt: null,
        lastStatus: null,
        ...over
    };
}

beforeEach(() => {
    crons = [];
    runs = [];
    appRunning = true;
    commandCode = 0;
    notified.length = 0;
});

describe("a due job", () => {
    it("runs once, and the next firing moves on", async () => {
        crons = [cron()];
        const now = new Date("2026-09-10T10:00:30Z");
        expect(await tickServiceCrons(now)).toEqual({ started: 1, skipped: 0 });
        await settle();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ status: "succeeded", output: "done\n" });
        expect(crons[0]!.nextRunAt?.toISOString()).toBe("2026-09-10T10:05:00.000Z");
        // The same minute read again finds nothing left to claim.
        expect(await tickServiceCrons(now)).toEqual({ started: 0, skipped: 0 });
    });

    it("is skipped, and says so, while the previous run is still going", async () => {
        crons = [cron()];
        runs = [
            {
                id: "r0",
                cronId: "c1",
                trigger: "schedule",
                attempt: 1,
                status: "running",
                exitCode: null,
                output: "",
                error: null,
                startedAt: new Date("2026-09-10T09:59:50Z"),
                finishedAt: null
            }
        ];
        expect(await tickServiceCrons(new Date("2026-09-10T10:00:30Z"))).toEqual({ started: 0, skipped: 1 });
        expect(runs.at(-1)).toMatchObject({ status: "skipped" });
    });
});

describe("a job that fails", () => {
    it("is tried again after the wait, and only the last try raises an alert", async () => {
        commandCode = 2;
        crons = [cron({ maxAttempts: 2 })];
        await tickServiceCrons(new Date("2026-09-10T10:00:30Z"));
        await settle();
        expect(runs[0]).toMatchObject({ status: "failed", exitCode: 2 });
        expect(crons[0]!.retryAttempt).toBe(2);
        expect(crons[0]!.retryAt).not.toBeNull();
        expect(notified).toEqual([]);

        await tickServiceCrons(new Date(crons[0]!.retryAt!.getTime() + 1000));
        await settle();
        expect(runs[1]).toMatchObject({ trigger: "retry", attempt: 2, status: "failed" });
        expect(notified).toHaveLength(1);
    });

    it("says the service was not running rather than pretending it ran", async () => {
        appRunning = false;
        crons = [cron()];
        await tickServiceCrons(new Date("2026-09-10T10:00:30Z"));
        await settle();
        expect(runs[0]).toMatchObject({ status: "failed" });
        expect(runs[0]!.error).toContain("not running");
    });
});
