/**
 * Where an upload from a visitor lands when it is not allowed to overwrite.
 *
 * Two things have to hold at once and they pull against each other: the sender's
 * filename survives untouched, because the person collecting the files has to
 * recognize what they were sent, and no upload ever lands on top of a file that
 * is already there. The interesting cases are therefore the collision (numbered,
 * extension intact) and the race - two uploads of one name arriving together,
 * which a plain "is it free? then write it" would resolve by letting the second
 * silently replace the first.
 */

import { numberedName } from "@polaris/core";
import { describe, expect, it } from "vitest";
import { claimUploadPath, replaceWithStaged } from "../../src/lib/upload-naming";
import { StorageError, type StatEntry, type StorageDriver } from "@polaris/storage";

/** A driver backed by a set of paths, recording every write it is asked for. */
function fakeDriver(
    existing: string[] = [],
    options: { statDelayMs?: number; moveFromFails?: string } = {}
) {
    const files = new Set(existing);
    const writes: string[] = [];
    const driver = {
        id: `conn-${existing.length}-${Math.round(performance.now() * 1000)}`,
        async stat(path: string): Promise<StatEntry> {
            if (options.statDelayMs) {
                await new Promise((resolve) => setTimeout(resolve, options.statDelayMs));
            }
            if (!files.has(path)) throw new StorageError("not_found", `Not found: ${path}`);
            return {
                name: path,
                path,
                kind: "file",
                size: 1n,
                modifiedAt: new Date(0)
            };
        },
        async writeStream(path: string): Promise<StatEntry> {
            writes.push(path);
            files.add(path);
            return { name: path, path, kind: "file", size: 0n, modifiedAt: new Date(0) };
        },
        async move(from: string, to: string): Promise<void> {
            if (!files.has(from)) throw new StorageError("not_found", `Not found: ${from}`);
            // Keyed on the source, so a test can fail the move that puts the new file
            // in place without also failing the one that puts the old one back.
            if (options.moveFromFails === from) {
                throw new StorageError("io_error", `Cannot move ${from}`);
            }
            files.delete(from);
            files.add(to);
        },
        async delete(path: string): Promise<void> {
            files.delete(path);
        }
    } as unknown as StorageDriver;
    return { driver, files, writes };
}

describe("numbering a name that is taken", () => {
    it("leaves the first arrival's name exactly as it was sent", () => {
        expect(numberedName("Contrato firmado.pdf", 1)).toBe("Contrato firmado.pdf");
    });

    it("puts the number before the extension, never after it", () => {
        expect(numberedName("contrato.pdf", 2)).toBe("contrato (2).pdf");
        expect(numberedName("contrato.pdf", 3)).toBe("contrato (3).pdf");
    });

    it("keeps the last extension of a double-extension name", () => {
        expect(numberedName("backup.tar.gz", 2)).toBe("backup.tar (2).gz");
    });

    it("appends at the end when there is no extension to protect", () => {
        expect(numberedName("LICENSE", 2)).toBe("LICENSE (2)");
        expect(numberedName(".gitignore", 2)).toBe(".gitignore (2)");
    });
});

describe("claiming a path for an upload", () => {
    it("keeps the requested name when the folder does not already hold it", async () => {
        const { driver, writes } = fakeDriver(["Legal/otro.pdf"]);
        const claimed = await claimUploadPath(driver, "Legal/contrato.pdf");
        expect(claimed).toBe("Legal/contrato.pdf");
        expect(writes).toEqual(["Legal/contrato.pdf"]);
    });

    it("numbers past every variant already taken", async () => {
        const { driver } = fakeDriver([
            "Legal/contrato.pdf",
            "Legal/contrato (2).pdf",
            "Legal/contrato (3).pdf"
        ]);
        expect(await claimUploadPath(driver, "Legal/contrato.pdf")).toBe("Legal/contrato (4).pdf");
    });

    it("works at the root of a connection, where there is no parent folder", async () => {
        const { driver } = fakeDriver(["contrato.pdf"]);
        expect(await claimUploadPath(driver, "contrato.pdf")).toBe("contrato (2).pdf");
    });

    it("gives two simultaneous uploads of one name two different files", async () => {
        // The delay is what makes this a race: both calls look the name up before
        // either has written, which is exactly when an unserialized claim loses a file.
        const { driver } = fakeDriver([], { statDelayMs: 5 });
        const [first, second] = await Promise.all([
            claimUploadPath(driver, "Legal/contrato.pdf"),
            claimUploadPath(driver, "Legal/contrato.pdf")
        ]);
        expect(new Set([first, second])).toEqual(
            new Set(["Legal/contrato.pdf", "Legal/contrato (2).pdf"])
        );
    });

    it("refuses to guess when the folder cannot be read, rather than overwriting", async () => {
        const driver = {
            id: "conn-denied",
            async stat(): Promise<StatEntry> {
                throw new StorageError("permission_denied", "Nope");
            },
            async writeStream(): Promise<StatEntry> {
                throw new Error("must not write");
            }
        } as unknown as StorageDriver;
        await expect(claimUploadPath(driver, "Legal/contrato.pdf")).rejects.toThrow(StorageError);
    });
});

describe("putting an accepted upload in place of the file it replaces", () => {
    it("does nothing when the upload already landed where it belongs", async () => {
        const { driver, files } = fakeDriver(["Legal/contrato.pdf"]);
        await replaceWithStaged(driver, "Legal/contrato.pdf", "Legal/contrato.pdf");
        expect([...files]).toEqual(["Legal/contrato.pdf"]);
    });

    it("replaces the target and leaves nothing behind", async () => {
        const { driver, files } = fakeDriver(["Legal/contrato.pdf", "Legal/contrato (2).pdf"]);
        await replaceWithStaged(driver, "Legal/contrato (2).pdf", "Legal/contrato.pdf");
        expect([...files]).toEqual(["Legal/contrato.pdf"]);
    });

    it("puts the original back when the replacement cannot be moved in", async () => {
        // The window this guards is the one that matters: the old file has already
        // been moved aside, so a failure here would otherwise leave neither.
        const { driver, files } = fakeDriver(["Legal/contrato.pdf", "Legal/contrato (2).pdf"], {
            moveFromFails: "Legal/contrato (2).pdf"
        });
        await expect(
            replaceWithStaged(driver, "Legal/contrato (2).pdf", "Legal/contrato.pdf")
        ).rejects.toThrow(StorageError);
        expect(files.has("Legal/contrato.pdf")).toBe(true);
        expect([...files].some((path) => path.includes("polaris-replaced"))).toBe(false);
    });
});
