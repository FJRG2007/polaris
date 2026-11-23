/**
 * The game watcher reads the store games from the launcher's listing and never
 * makes it read the stores again on a look: one listing when none was ever
 * read, then only what the launcher keeps fresh. Electron, the file system and
 * the stores are stand-ins; nothing on this computer is read.
 */

import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeApps = vi.fn();

vi.mock("electron", () => ({ shell: { openPath: vi.fn(), openExternal: vi.fn() } }));
/** A Start menu with one shortcut in it. */
vi.mock("node:fs/promises", () => ({
    readdir: vi.fn(async (path: string) => (/Programs$/.test(path) ? [{ name: "Hades II.lnk", isDirectory: () => false }] : []))
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../../src/main/launcher-stores", () => ({
    storeApps: (...args: unknown[]) => storeApps(...args),
    isPackagedAppId: () => true,
    isVettedLaunchUri: () => true
}));

beforeEach(() => {
    vi.resetModules();
    storeApps.mockReset();
});

describe("store games for the game watcher", () => {
    it("starts one listing on the first ask, then answers from it however often it is asked", async () => {
        storeApps.mockResolvedValue([
            { label: "Hades II", path: "steam:1145350", launch: { kind: "uri", uri: "steam://rungameid/1145350" }, folder: "D:\\Steam\\steamapps\\common\\Hades II" },
            { label: "Xbox", path: "packaged:a!b", launch: { kind: "packaged", id: "a!b" } }
        ]);
        const apps = await import("../../src/main/launcher-apps");
        expect(apps.installedGames("win32")).toEqual([]);
        await apps.installedAppsRead("win32");
        for (let look = 0; look < 5; look++) {
            expect(apps.installedGames("win32")).toEqual([{ name: "Hades II", folder: "D:\\Steam\\steamapps\\common\\Hades II" }]);
        }
        expect(storeApps).toHaveBeenCalledTimes(1);
    });

    it("keeps a store game's folder when the launcher lists it by its Start menu shortcut", async () => {
        storeApps.mockResolvedValue([{ label: "Hades II", path: "steam:1", launch: { kind: "uri", uri: "steam://rungameid/1" }, folder: "D:\\Games\\Hades II" }]);
        vi.stubEnv("ProgramData", "C:\\ProgramData");
        vi.stubEnv("APPDATA", "");
        try {
            const apps = await import("../../src/main/launcher-apps");
            const listed = await apps.installedAppsRead("win32");
            expect(listed.map((app) => app.path)).toEqual([join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "Hades II.lnk")]);
            expect(apps.installedGames("win32")).toEqual([{ name: "Hades II", folder: "D:\\Games\\Hades II" }]);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("reads nothing for it on a system without store games", async () => {
        const apps = await import("../../src/main/launcher-apps");
        expect(apps.installedGames("linux")).toEqual([]);
        expect(storeApps).not.toHaveBeenCalled();
    });
});
