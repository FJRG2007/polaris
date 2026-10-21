import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UnasMetrics } from "@/lib/unifi-unas";
import type { UnasAlert } from "@/lib/unifi-unas-control";

const NAS = "c1";
const OWNER = "owner";

let storedKeys: string[] = [];
let bell: { id: string; userId: string; type: string; metadata: string | null }[] = [];

const notify = vi.fn(
    async (input: { userId: string; event: string; metadata?: Record<string, unknown> }) => {
        // Serialized the way createNotification stores it.
        bell.unshift({
            id: `n${bell.length + 1}`,
            userId: input.userId,
            type: input.event,
            metadata: input.metadata ? JSON.stringify(input.metadata) : null
        });
        return {};
    }
);
const emitAutomationEvent = vi.fn(async () => undefined);
const recordNasSample = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        storageConnection: {
            findUnique: async () => ({
                id: NAS,
                name: "nas",
                ownerId: OWNER,
                kind: "unifi-unas",
                nasAlertKeys: storedKeys
            }),
            update: async ({ data }: { data: { nasAlertKeys: string[] } }) => {
                storedKeys = data.nasAlertKeys;
            }
        },
        notification: {
            findMany: async ({
                where
            }: {
                where: { userId: string; type: string; metadata: { startsWith: string } };
            }) =>
                bell.filter(
                    (row) =>
                        row.userId === where.userId &&
                        row.type === where.type &&
                        (row.metadata ?? "").startsWith(where.metadata.startsWith)
                ),
            deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                bell = bell.filter((row) => !where.id.in.includes(row.id));
            }
        }
    }
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string) => key
}));
vi.mock("@/lib/storage-service", () => ({ getUnasTarget: vi.fn() }));
vi.mock("@/lib/automations/outbox", () => ({ emitAutomationEvent }));
vi.mock("@/lib/nas/nas-history", () => ({
    recordNasSample,
    pruneNasSamples: async () => undefined
}));

const { noticePlan, staleNotices, watchUnasAlerts } = await import("@/lib/unas-alerts");
const { watchNas } = await import("@/lib/nas/nas-watch");

const failedBackup: UnasAlert = {
    kind: "backup-failed",
    key: "backup:t1",
    subject: "Nightly",
    value: null
};
const hotDisk: UnasAlert = { kind: "disk-temperature", key: "temp:1", subject: "1", value: 60 };

const meta = (alert: string) => JSON.stringify({ connectionId: "c1", alert });

describe("unas-alerts noticePlan", () => {
    it("raises only what the stored keys do not already hold, across a restart too", () => {
        const plan = noticePlan(["temp:1"], [hotDisk, failedBackup], true);
        expect(plan.fresh).toEqual([failedBackup]);
        expect([...plan.standing].sort()).toEqual(["backup:t1", "temp:1"]);
    });

    it("holds the stored backup keys when the tasks could not be read", () => {
        const plan = noticePlan(["backup:t1", "temp:1"], [], false);
        expect(plan.fresh).toEqual([]);
        expect([...plan.standing]).toEqual(["backup:t1"]);
    });

    it("lets backup keys clear once the tasks are read and healthy", () => {
        expect([...noticePlan(["backup:t1"], [], true).standing]).toEqual([]);
    });
});

describe("unas-alerts staleNotices", () => {
    it("keeps the newest notice of a standing condition and deletes older copies", () => {
        const notices = [
            { id: "new", metadata: meta("pool:md3") },
            { id: "old", metadata: meta("pool:md3") },
            { id: "older", metadata: meta("pool:md3") }
        ];
        expect(staleNotices(notices, new Set(["pool:md3"]))).toEqual(["old", "older"]);
    });

    it("deletes every notice whose condition no longer stands", () => {
        const notices = [
            { id: "a", metadata: meta("pool:md3") },
            { id: "b", metadata: meta("temp:1") },
            { id: "c", metadata: null }
        ];
        expect(staleNotices(notices, new Set(["temp:1"]))).toEqual(["a", "c"]);
    });
});

const fullPool = {
    totalBytes: 1000,
    usedBytes: 950,
    pools: [
        {
            device: "md0",
            raidLevel: "raid5",
            raidState: "normal",
            membersExpected: 1,
            membersPresent: 1,
            usedBytes: 950,
            totalBytes: 1000
        }
    ],
    disks: [],
    system: { name: "nas" }
} as unknown as UnasMetrics;

/** One storage tick, in the metrics collector's order. */
async function tick(at: number): Promise<void> {
    const unas = { id: NAS, ownerId: OWNER };
    await watchUnasAlerts(unas, fullPool, []);
    await watchNas(NAS, fullPool, new Date(at), []);
}

describe("unas-alerts watchUnasAlerts with the NAS watcher", () => {
    beforeEach(() => {
        storedKeys = [];
        bell = [];
        vi.clearAllMocks();
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("rings once for a standing condition and keeps one notice on the bell", async () => {
        await tick(1);
        await tick(2);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(storedKeys).toEqual(["usage:md0"]);
        expect(bell.map((row) => row.metadata)).toEqual([meta("usage:md0")]);
    });

    it("does not ring again when the sample or the automation event keeps failing", async () => {
        recordNasSample.mockRejectedValue(new Error("sample"));
        emitAutomationEvent.mockRejectedValue(new Error("outbox"));
        await tick(1);
        await tick(2);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(storedKeys).toEqual(["usage:md0"]);
    });

    it("clears the notice when the condition clears, and sweeps only this NAS", async () => {
        bell.push({
            id: "other",
            userId: OWNER,
            type: "storage.nasAlert",
            metadata: JSON.stringify({ connectionId: "c10", alert: "usage:md0" })
        });
        await tick(1);
        const healthy = {
            ...fullPool,
            usedBytes: 10,
            pools: [{ ...fullPool.pools[0], usedBytes: 10 }]
        } as UnasMetrics;
        await watchUnasAlerts({ id: NAS, ownerId: OWNER }, healthy, []);
        expect(bell.map((row) => row.id)).toEqual(["other"]);
    });
});
