import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { verifySigned } from "@/main/plugins/signature";
import { afterEach, describe, expect, it } from "vitest";
import { cachedCatalog, openCatalog, refreshCatalog, writeWhole } from "@/main/plugins/catalog";
import { catalogOf, entryFor, fakeFetch, fixturePackage, sign, TEST_KEYS } from "./fixtures";

const URL = "https://github.com/FJRG2007/polaris/releases/download/device-plugins/catalog.json";
const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plugins-catalog-"));
    dirs.push(dir);
    return dir;
}
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("catalog signature", () => {
    const bytes = bytesOf(catalogOf([entryFor(fixturePackage())]));

    it("takes a catalog signed by a trusted key", () => {
        expect(openCatalog(bytes, sign(bytes), TEST_KEYS)?.plugins[0]?.id).toBe("fixture-mixer");
    });

    it("refuses a changed byte, an unknown key and a malformed signature file", () => {
        const changed = bytes.slice();
        changed[10] = changed[10]! ^ 1;
        expect(openCatalog(changed, sign(bytes), TEST_KEYS)).toBeNull();
        expect(openCatalog(bytes, sign(bytes, "other"), TEST_KEYS)).toBeNull();
        expect(openCatalog(bytes, "not json", TEST_KEYS)).toBeNull();
        expect(verifySigned(bytes, { keyId: "test-key", signature: "x" }, TEST_KEYS)).toBe(false);
    });

    it("refuses a catalog signed by a key the app does not hold", () => {
        expect(openCatalog(bytes, sign(bytes))).toBeNull();
    });
});

describe("catalog refresh", () => {
    it("keeps a newer signed catalog on the device and reads it back offline", async () => {
        const dir = await tempDir();
        const bytes = bytesOf(catalogOf([entryFor(fixturePackage())]));
        const result = await refreshCatalog(dir, fakeFetch({ [URL]: bytes, [`${URL}.sig`]: sign(bytes) }), null, URL, TEST_KEYS);
        expect(result.kind).toBe("updated");
        expect((await cachedCatalog(dir, TEST_KEYS))?.plugins).toHaveLength(1);
    });

    it("never trades the catalog it holds for an older one", async () => {
        const dir = await tempDir();
        const held = catalogOf([], "2026-11-21T00:00:00.000Z");
        const older = bytesOf(catalogOf([entryFor(fixturePackage())], "2026-11-20T00:00:00.000Z"));
        const result = await refreshCatalog(dir, fakeFetch({ [URL]: older, [`${URL}.sig`]: sign(older) }), held, URL, TEST_KEYS);
        expect(result.kind).toBe("unchanged");
        expect(await cachedCatalog(dir, TEST_KEYS)).toBeNull();
    });

    it("leaves the copy as it was when the fetch or the signature fails", async () => {
        const dir = await tempDir();
        const bytes = bytesOf(catalogOf([]));
        expect((await refreshCatalog(dir, fakeFetch({}), null, URL, TEST_KEYS)).kind).toBe("failed");
        const forged = await refreshCatalog(dir, fakeFetch({ [URL]: bytes, [`${URL}.sig`]: sign(bytesOf({ other: 1 })) }), null, URL, TEST_KEYS);
        expect(forged.kind).toBe("failed");
        expect(await cachedCatalog(dir, TEST_KEYS)).toBeNull();
    });
});

describe("writeWhole", () => {
    // Windows refuses a rename over a file any handle has open (EPERM): a store page
    // reading installed.json the moment an install wrote it failed desktop 0.1.99's install.
    it("replaces a file that is open elsewhere once it is let go", async () => {
        const path = join(await tempDir(), "installed.json");
        await writeFile(path, "{}");
        const reader = await open(path, "r");
        const released = new Promise<void>((resolve) => setTimeout(() => void reader.close().then(resolve), 50));
        await writeWhole(path, '{"schema":1}');
        await released;
        expect(await readFile(path, "utf8")).toBe('{"schema":1}');
    });
});
