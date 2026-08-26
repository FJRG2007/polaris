/**
 * What the edge is left with when writing its config goes wrong.
 *
 * The directory these files live in is read by Traefik as it changes, and `writeFile`
 * truncates before it writes - so a write that fails partway leaves a file of zero
 * bytes. For the file holding the app routes that is not a smaller config, it is no
 * routing at all: every deployed domain answers `404 page not found` while the services
 * behind them are running. The properties worth pinning are that a failed write changes
 * nothing, and that two writers of one file cannot land inside each other's bytes.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** Set by the test that needs the write itself to give out, the way a full disk does.
 *  `refuseRenames` is the other half: how many renames are turned away before one is
 *  allowed through, which is what a filesystem does to two writers of one file. */
const control = vi.hoisted(() => ({
    failWrite: false,
    refuseRenames: 0,
    renames: 0,
    written: [] as string[]
}));

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            control.written.push(String(args[0]));
            if (control.failWrite) throw new Error("ENOSPC: no space left on device");
            return actual.writeFile(...args);
        },
        rename: async (...args: Parameters<typeof actual.rename>) => {
            control.renames += 1;
            if (control.refuseRenames > 0) {
                control.refuseRenames -= 1;
                const refused: NodeJS.ErrnoException = new Error(
                    `EPERM: operation not permitted, rename '${String(args[0])}'`
                );
                refused.code = "EPERM";
                throw refused;
            }
            return actual.rename(...args);
        }
    };
});

let dynamic = "";

beforeAll(async () => {
    dynamic = await mkdtemp(join(tmpdir(), "polaris-dynamic-"));
    process.env.POLARIS_TRAEFIK_DYNAMIC_DIR = dynamic;
});

afterEach(() => {
    control.failWrite = false;
    control.refuseRenames = 0;
    control.renames = 0;
    control.written = [];
});

afterAll(async () => {
    await rm(dynamic, { recursive: true, force: true });
});

/** Imported after the directory exists, so the module reads the test's own. */
async function writer() {
    return (await import("@/lib/traefik-dynamic")).writeDynamicFile;
}

/** Whatever is in the directory that no reload should ever be reading. */
async function leftovers(): Promise<string[]> {
    return (await readdir(dynamic)).filter((name) => name.endsWith(".tmp"));
}

describe("writing a file the edge watches", () => {
    it("leaves the content in place and nothing beside it", async () => {
        await (
            await writer()
        )("polaris-apps.yml", "http: {}\n");

        expect(await readFile(join(dynamic, "polaris-apps.yml"), "utf8")).toBe("http: {}\n");
        expect(await readdir(dynamic)).toEqual(["polaris-apps.yml"]);
    });

    it("keeps the previous routes when the write fails", async () => {
        const write = await writer();
        const file = "polaris-keep.yml";
        await write(file, "http: routers\n");
        control.failWrite = true;

        await expect(write(file, "http: newer\n")).rejects.toThrow();

        expect(await readFile(join(dynamic, file), "utf8")).toBe("http: routers\n");
        expect(await leftovers()).toEqual([]);
    });

    it("gives two writers of one file a temporary name each", async () => {
        const write = await writer();
        const file = "polaris-shared.yml";

        await Promise.all([write(file, "http: first\n"), write(file, "http: second\n")]);

        const temps = control.written.filter((path) => path.endsWith(".tmp"));
        expect(temps).toHaveLength(2);
        expect(new Set(temps).size).toBe(2);
        // Whichever renamed last, the file is one of the two configs whole - never a
        // mixture of both, and never the empty file one shared name can leave behind.
        expect(["http: first\n", "http: second\n"]).toContain(
            await readFile(join(dynamic, file), "utf8")
        );
        expect(await leftovers()).toEqual([]);
    });

    it("waits out a rename that was refused rather than losing the routes", async () => {
        // Two writers landing on one file at the same moment is ordinary here, and
        // a filesystem that refuses the second rename instead of serialising it
        // would otherwise tell that caller its routes did not land when the bytes
        // were already written. Windows does exactly this, which is where the
        // intermittent EPERM in this suite came from.
        const write = await writer();
        const file = "polaris-refused.yml";
        control.refuseRenames = 2;

        await write(file, "http: landed\n");

        expect(await readFile(join(dynamic, file), "utf8")).toBe("http: landed\n");
        expect(control.renames).toBe(3);
        expect(await leftovers()).toEqual([]);
    });

    it("gives up on a rename that keeps being refused, rather than trying forever", async () => {
        const write = await writer();
        control.refuseRenames = 99;

        await expect(write("polaris-hopeless.yml", "http: never\n")).rejects.toThrow(/EPERM/);
        // And the temporary file goes with it: a directory the edge reads must not
        // collect one of those per failure.
        expect(await leftovers()).toEqual([]);
    });

    it("writes a restricted file through the same path", async () => {
        const write = await writer();
        await write("polaris-secret.key", "PRIVATE", { mode: 0o600 });

        expect(await readFile(join(dynamic, "polaris-secret.key"), "utf8")).toBe("PRIVATE");
    });
});
