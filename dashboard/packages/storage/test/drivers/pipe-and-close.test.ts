/**
 * A copy whose source fails part-way lets go of the file it was writing.
 *
 * `pipe` leaves the destination open when the source errors, which is what an
 * upload whose sender hung up looks like. The caller then deleted a file that was
 * still open: on a CIFS-mounted share the kernel keeps such a file as
 * `.__smbXXXX`, and with the handle never closed it stayed in the folder.
 */

import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pipeAndClose } from "../../src/driver.js";

describe("a copy whose source fails", () => {
    it("closes the destination before handing back the error", async () => {
        const source = new PassThrough();
        const out = new Writable({ write: (_chunk, _encoding, next) => next() });
        const copy = pipeAndClose(source, out);
        source.write("part of a file");
        source.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
        await expect(copy).rejects.toThrow("aborted");
        expect(out.destroyed).toBe(true);
        expect(out.closed).toBe(true);
    });

    it("still resolves once a complete copy is closed", async () => {
        const source = new PassThrough();
        const out = new Writable({ write: (_chunk, _encoding, next) => next() });
        const copy = pipeAndClose(source, out);
        source.end("a whole file");
        await expect(copy).resolves.toBeUndefined();
        expect(out.destroyed).toBe(true);
    });
});
