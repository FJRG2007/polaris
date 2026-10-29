/**
 * Replacing an AppImage: the new file takes the old one's place only when it
 * is whole and matches its checksum, and is executable when it does. Any
 * failure leaves the old file as it was and nothing beside it.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { replaceAppImage } from "@/main/appimage";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const OLD = Buffer.from("old AppImage");
const NEW = Buffer.alloc(200_000, 7);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A download answering `bytes` in chunks, or `status` with nothing. */
const serve = (bytes: Buffer, status = 200) => async () =>
    new Response(status === 200 ? new Blob([new Uint8Array(bytes)]).stream() : null, { status });

describe("replaceAppImage", () => {
    const made: string[] = [];
    afterEach(() => {
        for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    const stage = () => {
        const directory = mkdtempSync(join(tmpdir(), "appimage-"));
        made.push(directory);
        const target = join(directory, "Polaris-0.1.0-x64.AppImage");
        writeFileSync(target, OLD, { mode: 0o755 });
        return { directory, target };
    };

    it("puts a matching download in the old one's place, executable", async () => {
        const { directory, target } = stage();
        await replaceAppImage(target, "https://example.test/a", { size: NEW.length, sha256: digest(NEW) }, serve(NEW));
        expect(readFileSync(target).equals(NEW)).toBe(true);
        if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o755);
        expect(readdirSync(directory)).toEqual(["Polaris-0.1.0-x64.AppImage"]);
    });

    it.each([
        ["a checksum that does not match", { size: NEW.length, sha256: digest(OLD) }, serve(NEW)],
        ["a download shorter than the release says", { size: NEW.length + 1, sha256: digest(NEW) }, serve(NEW)],
        ["a download longer than the release says", { size: NEW.length - 1, sha256: digest(NEW) }, serve(NEW)],
        ["an error status", { size: NEW.length, sha256: digest(NEW) }, serve(NEW, 404)],
        [
            "a connection that fails",
            { size: NEW.length, sha256: digest(NEW) },
            async () => {
                throw new Error("offline");
            }
        ]
    ])("keeps the old file on %s", async (_case, expected, fetch) => {
        const { directory, target } = stage();
        await expect(replaceAppImage(target, "https://example.test/a", expected, fetch)).rejects.toThrow();
        expect(readFileSync(target).equals(OLD)).toBe(true);
        expect(readdirSync(directory)).toEqual(["Polaris-0.1.0-x64.AppImage"]);
    });
});
