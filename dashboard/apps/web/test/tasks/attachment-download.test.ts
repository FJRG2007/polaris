/**
 * Downloading a task attachment borrows a pooled session like any other read, and
 * the handler returns before the bytes do: the session has to come back when the
 * response ends, or the connection stays pinned for the life of the process.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION = "018f2b7a-0000-7000-8000-0000000000e1";

const findUnique = vi.fn();
const dispose = vi.fn(async () => undefined);
const readStream = vi.fn(async () => sourceOf(["one", "two"]));
const driverForTarget = vi.fn(async () => ({ readStream, dispose }));

vi.mock("@polaris/db", () => ({ prisma: { taskAttachment: { findUnique } } }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined)
}));
vi.mock("@/lib/storage-target", () => ({
    AUTOMATIC_TARGET: "auto",
    LOCAL_TARGET: "local",
    driverForTarget,
    resolveStorageTarget: vi.fn(),
    safeName: (name: string) => name,
    storageTargetOptions: vi.fn(async () => [])
}));

const { readAttachment } = await import("../../src/lib/tasks/attachment-service");

function sourceOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        }
    });
}

describe("attachment downloads", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readStream.mockImplementation(async () => sourceOf(["one", "two"]));
        driverForTarget.mockImplementation(async () => ({ readStream, dispose }));
        findUnique.mockImplementation(async () => ({
            id: "a1",
            name: "shot.png",
            mime: "image/png",
            size: 6,
            connectionId: CONNECTION,
            path: "polaris/tasks/t1/shot.png"
        }));
    });

    it("gives the session back once the response has been read", async () => {
        const file = await readAttachment("a1");

        expect(file).not.toBeNull();
        expect(dispose).not.toHaveBeenCalled();
        expect(await new Response(file!.body).text()).toBe("onetwo");
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("gives it back when the file cannot be opened at all", async () => {
        readStream.mockImplementation(async () => {
            throw new Error("ENOENT");
        });

        await expect(readAttachment("a1")).rejects.toThrow("ENOENT");
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("borrows nothing for an attachment that is not there", async () => {
        findUnique.mockImplementation(async () => null);

        expect(await readAttachment("gone")).toBeNull();
        expect(driverForTarget).not.toHaveBeenCalled();
    });
});
