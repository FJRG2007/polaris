import { describe, expect, it, vi } from "vitest";

import type { UnasAlert } from "@/lib/unifi-unas-control";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn() }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn() }));
vi.mock("@/lib/storage-service", () => ({ getUnasTarget: vi.fn() }));

const { noticePlan, staleNotices } = await import("@/lib/unas-alerts");

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
