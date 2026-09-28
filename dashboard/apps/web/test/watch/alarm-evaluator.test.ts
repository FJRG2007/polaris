/**
 * The evaluator reads a disk or network alarm from the right subject and fires
 * it once the breach holds.
 *
 * A server that is the machine Polaris runs on has its samples filed under the
 * reserved local subject, whichever way the alarm names it; reading its own id
 * instead finds nothing and leaves the alarm at "No data" for good. A service's
 * disk is its volumes, not a column of its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const LOCAL = "00000000-0000-4000-8000-000000000001";
const HOST = "0192f6a0-0000-7000-8000-0000000000aa";
const APP = "0192f6a0-0000-7000-8000-0000000000bb";
const MIB = 1024n * 1024n;
const GIB = 1024n * MIB;

interface Sample {
    subjectType: string;
    subjectId: string;
    ts: Date;
    cpuPercent: number | null;
    memUsedBytes: bigint | null;
    memTotalBytes: bigint | null;
    diskUsedBytes: bigint | null;
    diskTotalBytes: bigint | null;
    netRxBytes: bigint | null;
    netTxBytes: bigint | null;
}

let samples: Sample[] = [];
let alarms: Record<string, unknown>[] = [];
const updates: { id: string; state: string }[] = [];
const events: { kind: string; detail: string }[] = [];

function sample(subjectType: string, subjectId: string, agoMs: number, fields: Partial<Sample>): Sample {
    return {
        subjectType,
        subjectId,
        ts: new Date(Date.now() - agoMs),
        cpuPercent: null,
        memUsedBytes: null,
        memTotalBytes: null,
        diskUsedBytes: null,
        diskTotalBytes: null,
        netRxBytes: null,
        netTxBytes: null,
        ...fields
    };
}

function newest(where: { subjectType: string; subjectId: string; ts?: { gte: Date } }): Sample[] {
    return samples
        .filter(
            (row) =>
                row.subjectType === where.subjectType &&
                row.subjectId === where.subjectId &&
                (!where.ts || row.ts >= where.ts.gte)
        )
        .sort((a, b) => b.ts.getTime() - a.ts.getTime());
}

vi.mock("@polaris/db", () => ({
    prisma: {
        alarm: {
            findMany: vi.fn(async () => alarms),
            update: vi.fn(async ({ where, data }: { where: { id: string }; data: { state: string } }) => {
                updates.push({ id: where.id, state: data.state });
                const alarm = alarms.find((row) => row.id === where.id);
                if (alarm) Object.assign(alarm, data);
                return alarm;
            }),
            // Only the check time moves on these; their state is recorded as it
            // stands, so a test reads the last state either way.
            updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
                for (const id of where.id.in) {
                    const alarm = alarms.find((row) => row.id === id);
                    updates.push({ id, state: String(alarm?.state) });
                }
                return { count: where.id.in.length };
            })
        },
        alarmEvent: {
            create: vi.fn(async ({ data }: { data: { kind: string; detail: string } }) => {
                events.push({ kind: data.kind, detail: data.detail });
                return data;
            })
        },
        host: {
            findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.includes(HOST) ? [{ id: HOST, dockerId: "docker-local", address: "10.0.0.2" }] : []
            )
        },
        volume: {
            findMany: vi.fn(async () => [{ id: "vol-1" }, { id: "vol-2" }])
        },
        metricSample: {
            findMany: vi.fn(async ({ where, take }: { where: { subjectType: string; subjectId: string }; take: number }) =>
                newest(where).slice(0, take)
            ),
            findFirst: vi.fn(async ({ where }: { where: { subjectType: string; subjectId: string; ts?: { gte: Date } } }) =>
                newest(where)[0] ?? null
            )
        }
    }
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("@/lib/messaging/bridge-client", () => ({ bridgeSend: vi.fn(async () => undefined) }));
vi.mock("@/lib/local-machine", () => ({
    localMachineIdentity: vi.fn(async () => ({ hostId: null, dockerId: "docker-local", addresses: new Set<string>() })),
    isLocalMachine: (host: { dockerId?: string | null }, identity: { dockerId: string | null }) =>
        Boolean(host.dockerId && host.dockerId === identity.dockerId)
}));

const { evaluateAlarms } = await import("@/lib/watch/alarm-evaluator");

function alarm(fields: Record<string, unknown>): Record<string, unknown> {
    return {
        id: "alarm-1",
        ownerId: "owner-1",
        name: "Test",
        operator: "gt",
        threshold: 1,
        forPeriods: 1,
        state: "insufficient",
        breachStreak: 0,
        notifyChannelId: null,
        notifyPeerId: null,
        ...fields
    };
}

beforeEach(() => {
    samples = [];
    alarms = [];
    updates.length = 0;
    events.length = 0;
});

describe("disk and network alarms", () => {
    it("reads an enrolled copy of this machine from the local subject", async () => {
        samples = [sample("host", LOCAL, 30_000, { diskUsedBytes: 95n, diskTotalBytes: 100n })];
        alarms = [alarm({ targetType: "host", targetId: HOST, metric: "disk", threshold: 90 })];
        await evaluateAlarms();
        expect(updates.at(-1)?.state).toBe("alarm");
        expect(events).toEqual([{ kind: "triggered", detail: "Disk 95.0% (threshold > 90%)" }]);
    });

    it("fires on a traffic rate, not on the counter", async () => {
        samples = [
            sample("app", APP, 90_000, { netTxBytes: 0n }),
            sample("app", APP, 30_000, { netTxBytes: 60n * 3n * MIB })
        ];
        alarms = [alarm({ targetType: "application", targetId: APP, metric: "network_out", threshold: 2 })];
        await evaluateAlarms();
        expect(events[0]?.detail).toBe("Network out 3.00 MB/s (threshold > 2 MB/s)");
    });

    it("judges a service's disk on what its volumes hold together", async () => {
        samples = [
            sample("volume", "vol-1", 60_000, { diskUsedBytes: 2n * GIB }),
            sample("volume", "vol-2", 60_000, { diskUsedBytes: GIB })
        ];
        alarms = [alarm({ targetType: "application", targetId: APP, metric: "disk", threshold: 2.5 })];
        await evaluateAlarms();
        expect(events[0]?.detail).toBe("Disk 3.00 GB (threshold > 2.5 GB)");
    });

    it("says there is no data when the reading is stale, rather than firing or clearing", async () => {
        samples = [sample("host", LOCAL, 10 * 60_000, { diskUsedBytes: 99n, diskTotalBytes: 100n })];
        alarms = [alarm({ targetType: "host", targetId: LOCAL, metric: "disk", threshold: 90 })];
        await evaluateAlarms();
        expect(updates.at(-1)?.state).toBe("insufficient");
        expect(events).toEqual([]);
    });
});

describe("the pass's writes", () => {
    it("moves only the check time of an alarm whose state stands, in one statement", async () => {
        const { prisma } = await import("@polaris/db");
        samples = [sample("host", LOCAL, 30_000, { diskUsedBytes: 10n, diskTotalBytes: 100n })];
        alarms = [
            alarm({ id: "steady-1", targetType: "host", targetId: LOCAL, metric: "disk", threshold: 90, state: "ok" }),
            alarm({ id: "steady-2", targetType: "host", targetId: LOCAL, metric: "disk", threshold: 90, state: "ok" })
        ];
        vi.mocked(prisma.alarm.update).mockClear();
        vi.mocked(prisma.alarm.updateMany).mockClear();
        await evaluateAlarms();
        expect(prisma.alarm.update).not.toHaveBeenCalled();
        expect(prisma.alarm.updateMany).toHaveBeenCalledTimes(1);
        expect(vi.mocked(prisma.alarm.updateMany).mock.calls[0]?.[0]).toMatchObject({
            where: { id: { in: ["steady-1", "steady-2"] } },
            data: { lastEvaluatedAt: expect.any(Date) }
        });
    });

    it("still judges every alarm when the pass's shared read fails once", async () => {
        const { prisma } = await import("@polaris/db");
        vi.mocked(prisma.host.findMany).mockRejectedValueOnce(new Error("connection reset"));
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        samples = [sample("host", LOCAL, 30_000, { diskUsedBytes: 95n, diskTotalBytes: 100n })];
        alarms = [alarm({ targetType: "host", targetId: HOST, metric: "disk", threshold: 90 })];
        await expect(evaluateAlarms()).resolves.toBeUndefined();
        quiet.mockRestore();
        expect(updates.at(-1)?.state).toBe("alarm");
        expect(events).toEqual([{ kind: "triggered", detail: "Disk 95.0% (threshold > 90%)" }]);
    });
});
