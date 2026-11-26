import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginCatalog } from "@polaris/core/device-plugins";
import { pluginsFolder, readInstalled } from "@/main/plugins/packages";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

// Device plugins were called add-ons before: what an app from then left on disk
// and what CI published then still read.
const made: string[] = [];
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-plugins-"));
    made.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the folder from before the rename", () => {
    it("is moved to plugins the first time", () => {
        const data = scratch();
        mkdirSync(join(data, "addons", "packages"), { recursive: true });
        expect(pluginsFolder(data)).toBe(join(data, "plugins"));
        expect(existsSync(join(data, "plugins", "packages"))).toBe(true);
        expect(existsSync(join(data, "addons"))).toBe(false);
    });

    it("is left alone once plugins exists", () => {
        const data = scratch();
        mkdirSync(join(data, "plugins"));
        mkdirSync(join(data, "addons"));
        expect(pluginsFolder(data)).toBe(join(data, "plugins"));
        expect(existsSync(join(data, "addons"))).toBe(true);
    });

    it("names plugins when there is nothing to move", () => {
        const data = scratch();
        expect(pluginsFolder(data)).toBe(join(data, "plugins"));
    });
});

describe("installed.json from before the rename", () => {
    it("reads its addons list as the plugins", async () => {
        const dir = scratch();
        const entry = { version: "1.0.0", enabled: true, granted: [], installedAt: "2026-11-01T00:00:00.000Z" };
        writeFileSync(join(dir, "installed.json"), JSON.stringify({ schema: 1, addons: { "fixture-mixer": entry } }));
        expect((await readInstalled(dir)).plugins).toEqual({ "fixture-mixer": entry });
    });
});

describe("a catalog from before the rename", () => {
    const entries = { schema: 1, issued: "2026-11-01T00:00:00.000Z" };

    it("reads its addons list as the plugins", () => {
        expect(readPluginCatalog({ ...entries, addons: [] })?.plugins).toEqual([]);
    });

    it("prefers plugins when a catalog names both", () => {
        expect(readPluginCatalog({ ...entries, plugins: [], addons: "not a list" })?.plugins).toEqual([]);
    });
});
