/**
 * The timed sweep keeps the build cache a recent deploy made.
 *
 * Emptying the whole cache whenever the disk crossed the line made the next
 * deploy of every project a cold build, the active ones included. The sweep now
 * takes what no build has read for a few days first, and the rest only when
 * that did not bring the disk back under the line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const GB = 1024 * 1024 * 1024;
let disks: number[] = [];
const passes: { keepRecentBuilds?: boolean }[] = [];
let freedPerPass: number[] = [];

vi.mock("@polaris/db", () => ({ prisma: {}, VISIBLE_USER: {} }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn() }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn() }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined)
}));
vi.mock("@/lib/deploy/host-volumes", () => ({ hostVolumes: vi.fn(async () => []) }));
vi.mock("@/lib/deploy/local-disk", () => ({
    localDisk: vi.fn(async () => ({ used: disks.shift() ?? 0, total: 100 })),
    diskFullness: (disk: { used: number; total: number }) => disk.used / disk.total
}));
vi.mock("@/lib/deploy/host-space", () => ({
    hostSpace: vi.fn(async () => ({ reclaimable: 8 * GB })),
    reclaimHostSpace: vi.fn(async (options: { keepRecentBuilds?: boolean }) => {
        passes.push({ keepRecentBuilds: options.keepRecentBuilds });
        return freedPerPass.shift() ?? 0;
    })
}));

const { sweepHostSpace } = await import("@/lib/deploy/host-housekeeping");

beforeEach(() => {
    disks = [];
    passes.length = 0;
    freedPerPass = [];
});

describe("the timed sweep", () => {
    it("stops after the first pass when it was enough, keeping recent build cache", async () => {
        disks = [95, 70];
        freedPerPass = [5 * GB];
        const sweep = await sweepHostSpace();
        expect(passes).toEqual([{ keepRecentBuilds: true }]);
        expect(sweep).toMatchObject({ freed: 5 * GB, reclaimed: true, after: 0.7 });
    });

    it("takes the rest of the cache only when the disk is still over the line", async () => {
        disks = [97, 92, 80];
        freedPerPass = [1 * GB, 4 * GB];
        const sweep = await sweepHostSpace();
        expect(passes).toEqual([{ keepRecentBuilds: true }, { keepRecentBuilds: undefined }]);
        expect(sweep).toMatchObject({ freed: 5 * GB, reclaimed: true, after: 0.8 });
    });

    it("does nothing on a disk with room", async () => {
        disks = [40];
        const sweep = await sweepHostSpace();
        expect(passes).toEqual([]);
        expect(sweep.reclaimed).toBe(false);
    });
});
