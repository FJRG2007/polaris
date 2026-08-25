/**
 * What the edge is left with when writing its config goes wrong.
 *
 * The directory these files live in is read by Traefik as it changes, and `writeFile`
 * truncates before it writes - so a write that fails partway leaves a file of zero
 * bytes. For the file holding the app routes that is not a smaller config, it is no
 * routing at all: every deployed domain answers `404 page not found` while the services
 * behind them are running. The property worth pinning is that a failed write changes
 * nothing.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

let dynamic = "";

beforeAll(async () => {
    dynamic = await mkdtemp(join(tmpdir(), "polaris-dynamic-"));
    process.env.POLARIS_TRAEFIK_DYNAMIC_DIR = dynamic;
});

afterAll(async () => {
    await rm(dynamic, { recursive: true, force: true });
});

/** Imported after the directory exists, so the module reads the test's own. */
async function writer() {
    return (await import("@/lib/traefik-dynamic")).writeDynamicFile;
}

describe("writing a file the edge watches", () => {
    it("leaves the content in place and nothing beside it", async () => {
        await (await writer())("polaris-apps.yml", "http: {}\n");

        expect(await readFile(join(dynamic, "polaris-apps.yml"), "utf8")).toBe("http: {}\n");
        expect(await readdir(dynamic)).toEqual(["polaris-apps.yml"]);
    });

    it("keeps the previous routes when the write fails", async () => {
        const write = await writer();
        const file = "polaris-keep.yml";
        await write(file, "http: routers\n");
        // Nothing can be written to a name a directory already holds, which is this
        // test's stand-in for the disk, the container or the process giving out.
        await mkdir(join(dynamic, `${file}.tmp`), { recursive: true });
        await writeFile(join(dynamic, `${file}.tmp`, "occupied"), "", "utf8");

        await expect(write(file, "http: newer\n")).rejects.toThrow();

        expect(await readFile(join(dynamic, file), "utf8")).toBe("http: routers\n");
    });

    it("writes a restricted file through the same path", async () => {
        const write = await writer();
        await write("polaris-secret.key", "PRIVATE", { mode: 0o600 });

        expect(await readFile(join(dynamic, "polaris-secret.key"), "utf8")).toBe("PRIVATE");
    });
});
