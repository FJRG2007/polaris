/**
 * One pass of the disk watch: what it keeps, who it tells, and what a skipped
 * clean-up is reported as.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    settings: new Map<string, string>(),
    df: new Map<string, string | null>(),
    notified: [] as { body: string }[],
    swept: [] as { machine?: string; window?: number }[],
    sweep: [] as {
        machine: string;
        removed: number;
        freed: number;
        ran: boolean;
        busy?: boolean;
    }[],
    reclaim: (): Promise<number | null> => Promise.resolve(0)
}));

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: { user: { findMany: async () => [{ id: "admin-1" }] } }
}));
vi.mock("@/lib/deploy/local-disk", () => ({ localDisk: async () => null }));
vi.mock("@/lib/local-server", () => ({ getLocalServerName: async () => null }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string) => key
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (notice: { body: string }) => {
        state.notified.push(notice);
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => state.settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
        state.settings.set(key, value);
    }
}));
vi.mock("@/lib/deploy/host-space", () => ({
    hostSpace: async () => null,
    reclaimHostSpace: () => state.reclaim()
}));
vi.mock("@/lib/deploy/release-retention", () => ({
    parseEngineSize: () => 0,
    sweepReleaseImages: async (machine?: string, window?: number) => {
        state.swept.push({ machine, window });
        return state.sweep;
    }
}));
vi.mock("@/lib/deploy/server-space", () => ({
    DF_ROOT: "df",
    serversWithDeployments: async () => [{ id: "host-1", name: "web-1" }],
    onServer: async (_id: string, command: string) => state.df.get(command) ?? null,
    reclaimServerSpace: () => state.reclaim()
}));

import { ImageStoreBusy } from "@/lib/deploy/image-store-lock";
import { freeDiskSpace, lastDiskReadings, watchDisks } from "@/lib/deploy/disk-watch";

// 40 GB disk, 1 GB free: critical.
const CRITICAL_DF =
    "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 0 38085938 976562 98% /";

beforeEach(() => {
    state.settings.clear();
    state.df.clear();
    state.swept = [];
    state.notified.length = 0;
    state.sweep = [];
    state.reclaim = () => Promise.resolve(0);
});

describe("a disk watch pass", () => {
    it("keeps the last reading of a server it could not reach, and does not tell again", async () => {
        state.df.set("df", CRITICAL_DF);
        await watchDisks();
        expect(state.notified).toHaveLength(1);

        state.df.clear();
        const unreachable = await watchDisks();
        expect(unreachable.map((one) => one.machine)).toEqual(["host-1"]);
        expect((await lastDiskReadings())[0]?.level).toBe("critical");

        state.df.set("df", CRITICAL_DF);
        await watchDisks();
        expect(state.notified).toHaveLength(1);
    });

    it("says a deploy was running rather than that the clean-up ran", async () => {
        state.df.set("df", CRITICAL_DF);
        state.reclaim = () => Promise.reject(new ImageStoreBusy());
        state.sweep = [{ machine: "host-1", removed: 0, freed: 0, ran: false, busy: true }];
        await watchDisks();
        expect(state.notified[0]?.body).toBe("disk.busyBody");
    });
});

describe("freeing a disk", () => {
    it("is busy when a deploy held every step off", async () => {
        state.reclaim = () => Promise.reject(new ImageStoreBusy());
        state.sweep = [{ machine: "host-1", removed: 0, freed: 0, ran: false, busy: true }];
        expect(await freeDiskSpace("host-1")).toBe("busy");
    });

    it("reports what it freed even when one step was held off", async () => {
        state.reclaim = () => Promise.reject(new ImageStoreBusy());
        state.sweep = [{ machine: "host-1", removed: 1, freed: 500, ran: true }];
        expect(await freeDiskSpace("host-1")).toBe(500);
    });

    it("lets the rollback images go, since the disk is running out", async () => {
        state.sweep = [{ machine: "host-1", removed: 1, freed: 500, ran: true }];
        await freeDiskSpace("host-1");
        expect(state.swept.at(-1)).toEqual({ machine: "host-1", window: 0 });
    });

    it("is nothing when it ran and found nothing", async () => {
        state.sweep = [{ machine: "host-1", removed: 0, freed: 0, ran: true }];
        expect(await freeDiskSpace("host-1")).toBe(0);
    });

    it("is null when the machine could not be reached", async () => {
        state.reclaim = () => Promise.resolve(null);
        expect(await freeDiskSpace("host-1")).toBeNull();
    });
});
