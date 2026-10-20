import { describe, expect, it, vi } from "vitest";

import type { UnasMetrics } from "@/lib/unifi-unas";
import type { UnasAlert } from "@/lib/unifi-unas-control";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn() }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn() }));
vi.mock("@/lib/storage-service", () => ({ getUnasTarget: vi.fn() }));

const { currentAlerts } = await import("@/lib/unas-alerts");

const NOW = new Date("2026-10-20T12:00:00Z");

const healthy = {
    totalBytes: 100,
    usedBytes: 10,
    pools: [],
    disks: [],
    slotsTotal: 0,
    slotsPopulated: 0,
    health: "healthy",
    system: {
        name: "NAS",
        model: "UNAS",
        firmware: "",
        cpuTemp: null,
        cpuLoad: null,
        memoryUsedBytes: 0,
        memoryTotalBytes: 0,
        uptimeSeconds: 0
    },
    raw: {}
} satisfies UnasMetrics;

const failedBackup: UnasAlert = {
    kind: "backup-failed",
    key: "backup:t1",
    subject: "Nightly",
    value: null
};
const hotDisk: UnasAlert = { kind: "disk-temperature", key: "temp:1", subject: "1", value: 60 };

describe("unas-alerts currentAlerts", () => {
    it("keeps the previous backup alerts when the tasks could not be read", () => {
        expect(currentAlerts(healthy, null, [failedBackup, hotDisk], NOW)).toEqual([failedBackup]);
    });

    it("clears backup alerts once the tasks are read and healthy", () => {
        expect(currentAlerts(healthy, [], [failedBackup], NOW)).toEqual([]);
    });
});
