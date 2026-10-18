/**
 * A file taken off a storage arrives typed by its name. Drivers do not report a
 * content type, and a screen that checks one - an emoji, an animated avatar -
 * refused or flattened every pick from Drive without it.
 */

import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/drive-authz", () => ({
    requireDriveDriver: async () => ({
        stat: async () => ({ kind: "file", size: "3" }),
        readStream: async () => Readable.from([Buffer.from("GIF")]),
        dispose: async () => undefined
    })
}));

const { fileFromDrive } = await import("../../src/lib/attachments/from-elsewhere");

describe("a file picked from a storage", () => {
    it("carries the type its name says", async () => {
        const file = await fileFromDrive("user-1", "c1", "Party/Dance.GIF", 1024);
        expect(file.name).toBe("Dance.GIF");
        expect(file.type).toBe("image/gif");
    });

    it("stays untyped when the name says nothing", async () => {
        const file = await fileFromDrive("user-1", "c1", "notes", 1024);
        expect(file.type).toBe("");
    });
});
