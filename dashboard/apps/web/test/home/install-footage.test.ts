/**
 * Uninstalling Places with its data takes the footage files too.
 *
 * The clip and still rows cascade from the camera, so once the purge runs
 * nothing points at the files any more. They are deleted first, every page of
 * them, kept clips included, wherever each one was written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const cameras = [
    { id: "cam-a", installedAppId: "install-1" },
    { id: "cam-b", installedAppId: "install-1" },
    { id: "cam-c", installedAppId: "install-2" }
];
let clips: { id: string; cameraId: string; path: string }[] = [];
let events: { id: string; cameraId: string; stillKey: string | null }[] = [];
const deleted: string[] = [];

interface Page {
    where: { cameraId: { in: string[] }; id?: { gt: string }; stillKey?: unknown };
    take: number;
}

function page<T extends { id: string; cameraId: string }>(rows: T[], args: Page): T[] {
    return rows
        .filter((row) => args.where.cameraId.in.includes(row.cameraId))
        .filter((row) => !args.where.id || row.id > args.where.id.gt)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args.take);
}

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            findMany: async (args: { where: { installedAppId: string } }) =>
                cameras.filter((camera) => camera.installedAppId === args.where.installedAppId)
        },
        cameraClip: { findMany: async (args: Page) => page(clips, args) },
        cameraEvent: {
            findMany: async (args: Page) =>
                page(
                    events.filter((event) => event.stillKey !== null),
                    args
                )
        }
    }
}));

vi.mock("@/lib/storage-target", () => ({
    driverForTarget: async (targetId: string) => ({
        delete: async (path: string) => void deleted.push(`${targetId}:${path}`),
        dispose: async () => undefined
    })
}));

const { deleteInstallFootage } = await import("@polaris-app/places/src/lib/recording");

describe("deleteInstallFootage", () => {
    beforeEach(() => {
        deleted.length = 0;
        clips = [];
        events = [];
    });

    it("deletes every clip and still of the install's cameras, and nothing else", async () => {
        clips = [
            { id: "c1", cameraId: "cam-a", path: "local:polaris/home/clips/cam-a/1.mp4" },
            { id: "c2", cameraId: "cam-b", path: "nas-1:polaris/home/clips/cam-b/2.mp4" },
            { id: "c3", cameraId: "cam-c", path: "local:polaris/home/clips/cam-c/3.mp4" }
        ];
        events = [
            { id: "e1", cameraId: "cam-a", stillKey: "local:polaris/home/stills/cam-a/1.jpg" },
            { id: "e2", cameraId: "cam-b", stillKey: null },
            { id: "e3", cameraId: "cam-c", stillKey: "local:polaris/home/stills/cam-c/3.jpg" }
        ];
        await deleteInstallFootage("install-1");
        expect(deleted.sort()).toEqual([
            "local:polaris/home/clips/cam-a/1.mp4",
            "local:polaris/home/stills/cam-a/1.jpg",
            "nas-1:polaris/home/clips/cam-b/2.mp4"
        ]);
    });

    it("pages through more clips than one query reads", async () => {
        clips = Array.from({ length: 1201 }, (_, index) => ({
            id: `c${String(index).padStart(5, "0")}`,
            cameraId: "cam-a",
            path: `local:polaris/home/clips/cam-a/${index}.mp4`
        }));
        await deleteInstallFootage("install-1");
        expect(new Set(deleted).size).toBe(1201);
    });

    it("does nothing for an install with no cameras", async () => {
        clips = [{ id: "c1", cameraId: "cam-c", path: "local:x.mp4" }];
        await deleteInstallFootage("install-3");
        expect(deleted).toEqual([]);
    });
});
