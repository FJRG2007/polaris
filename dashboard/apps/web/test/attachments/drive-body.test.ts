/**
 * A large-file route can be sent where a file lies on a storage instead of the
 * file, and reads it there - so a Drive pick is held to the route's own ceiling,
 * not to what a browser can be handed and send back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const driver = {
    stat: vi.fn(async () => ({ kind: "file", size: 10, mime: "application/gzip" })),
    readStream: vi.fn(async () => new Blob(["backup"]).stream()),
    dispose: vi.fn(async () => undefined)
};
const requireDriveDriver = vi.fn(async () => driver);
vi.mock("@/lib/drive-authz", () => ({ requireDriveDriver }));

const { AttachRefused, openedDriveBody } = await import("@/lib/attachments/from-elsewhere");

function json(body: unknown): Request {
    return new Request("https://polaris.test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => vi.clearAllMocks());

describe("a request that names a file on a storage", () => {
    it("is left alone when the body is the file itself", async () => {
        const request = new Request("https://polaris.test/x", {
            method: "POST",
            headers: { "content-type": "application/gzip" },
            body: "bytes"
        });
        expect(await openedDriveBody(request, "user-1", 100)).toBeNull();
        expect(requireDriveDriver).not.toHaveBeenCalled();
    });

    it("opens the named file, authorized as the sender", async () => {
        const opened = await openedDriveBody(
            json({ connectionId: "c1", path: "backups/site.tar.gz" }),
            "user-1",
            100
        );
        expect(requireDriveDriver).toHaveBeenCalledWith(
            "user-1",
            "c1",
            "backups/site.tar.gz",
            "download"
        );
        expect(await new Response(opened!.body).text()).toBe("backup");
        await opened!.done();
        expect(driver.dispose).toHaveBeenCalled();
    });

    it("refuses a body that names nothing", async () => {
        await expect(openedDriveBody(json({ path: "a" }), "user-1", 100)).rejects.toBeInstanceOf(
            AttachRefused
        );
    });

    it("refuses a file over the route's ceiling before reading it", async () => {
        await expect(
            openedDriveBody(json({ connectionId: "c1", path: "big.tar.gz" }), "user-1", 5)
        ).rejects.toBeInstanceOf(AttachRefused);
        expect(driver.readStream).not.toHaveBeenCalled();
        expect(driver.dispose).toHaveBeenCalled();
    });
});
