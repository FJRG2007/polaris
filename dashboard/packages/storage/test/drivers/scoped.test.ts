/**
 * A driver confined to one folder.
 *
 * What matters is not that it prefixes paths - it is that the prefix is never
 * visible and never escapable. Everything above a driver (item metadata, shares,
 * breadcrumbs, the browser's own links) treats the paths it hands back as paths
 * it may hand straight back in, so a listing that leaked the real location would
 * quietly write rows pointing at somebody else's folder.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageError } from "../../src/driver.js";
import { LocalDriver } from "../../src/drivers/local.js";
import { ScopedDriver } from "../../src/drivers/scoped.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let root: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "polaris-scoped-"));
    await mkdir(join(root, "people", "ana", "photos"), { recursive: true });
    await writeFile(join(root, "people", "ana", "note.txt"), "mine");
    // A sibling that must never be reachable from inside the scope.
    await mkdir(join(root, "people", "ben"), { recursive: true });
    await writeFile(join(root, "people", "ben", "secret.txt"), "theirs");
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

async function open(prefix = "people/ana"): Promise<ScopedDriver> {
    const inner = new LocalDriver({ id: "disk", root });
    await inner.connect();
    const driver = new ScopedDriver({ id: "drive", inner, prefix });
    await driver.connect();
    return driver;
}

describe("a driver confined to a folder", () => {
    it("lists the folder as if it were the root", async () => {
        const driver = await open();
        const entries = (await driver.list("")).entries;
        expect(entries.map((entry) => entry.path).sort()).toEqual(["note.txt", "photos"]);
        await driver.dispose();
    });

    it("hands back paths that can be handed straight back in", async () => {
        const driver = await open();
        const [first] = (await driver.list("")).entries;
        // The round trip is the whole contract: every caller does exactly this.
        expect((await driver.stat(first.path)).name).toBe(first.name);
        await driver.dispose();
    });

    it("cannot be talked out of its folder", async () => {
        const driver = await open();
        await expect(driver.stat("../ben/secret.txt")).rejects.toThrow();
        await expect(driver.readStream("../../etc/passwd")).rejects.toThrow();
        await driver.dispose();
    });

    it("refuses to remove the folder itself", async () => {
        const driver = await open();
        await expect(driver.delete("")).rejects.toBeInstanceOf(StorageError);
        // What is inside it is still ordinary.
        await driver.mkdir("scratch");
        await driver.delete("scratch");
        await driver.dispose();
    });

    it("makes the folder when it is asked to", async () => {
        const inner = new LocalDriver({ id: "disk", root });
        await inner.connect();
        const driver = new ScopedDriver({
            id: "drive",
            inner,
            prefix: "people/new-account",
            createRoot: true
        });
        await driver.connect();
        expect((await driver.list("")).entries).toEqual([]);
        await driver.dispose();
    });

    it("does not make the folder unless asked", async () => {
        const inner = new LocalDriver({ id: "disk", root });
        await inner.connect();
        const driver = new ScopedDriver({ id: "drive", inner, prefix: "people/absent" });
        await driver.connect();
        await expect(driver.list("")).rejects.toThrow();
        await driver.dispose();
    });

    it("does not open a driver that is already open", async () => {
        // The registry hands back a connected driver, and opening one twice over
        // a pooled protocol borrows a second session that nothing gives back -
        // which pins the NAS session open for the life of the process.
        const inner = new LocalDriver({ id: "disk", root });
        await inner.connect();
        const connect = vi.spyOn(inner, "connect");
        const driver = new ScopedDriver({
            id: "drive",
            inner,
            prefix: "people/ana",
            innerConnected: true
        });

        await driver.connect();

        expect(connect).not.toHaveBeenCalled();
        // Still usable: the scope did not need to open it to work.
        expect((await driver.list("")).entries.length).toBeGreaterThan(0);
        await driver.dispose();
    });

    it("still makes its folder when the driver was handed to it open", async () => {
        const inner = new LocalDriver({ id: "disk", root });
        await inner.connect();
        const driver = new ScopedDriver({
            id: "drive",
            inner,
            prefix: "people/opened",
            createRoot: true,
            innerConnected: true
        });
        await driver.connect();
        expect((await driver.list("")).entries).toEqual([]);
        await driver.dispose();
    });

    it("is transparent with no prefix at all", async () => {
        const driver = await open("");
        expect((await driver.list("")).entries.map((entry) => entry.path)).toContain("people");
        await driver.dispose();
    });
});
