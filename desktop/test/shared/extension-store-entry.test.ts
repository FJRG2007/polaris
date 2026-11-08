/**
 * The desktop app's store entry for the extension: the documented, per-user way
 * other software asks a browser to install an extension from its store. No
 * administrator rights, idempotent, taken back on uninstall, and nothing at all
 * while the extension is in no store.
 */

import { describe, expect, it } from "vitest";
import {
    browserLaunch,
    CHROME_WEB_STORE_UPDATE,
    EDGE_ADDONS_UPDATE,
    EXTENSION_BROWSERS,
    externalEntry,
    registryAddLaunch,
    registryDeleteLaunch,
    windowsEntryKeys
} from "@/shared/install-tools";

const id = "a".repeat(32);
const listed = { chromeWebStore: id, edgeAddons: null };
const folders = { home: "/Users/me" };

describe("installing the extension from its store", () => {
    it("writes nothing while the extension is in no store", () => {
        for (const browser of EXTENSION_BROWSERS) {
            for (const platform of ["win32", "darwin", "linux"]) {
                expect(externalEntry(browser, platform, folders)).toBeNull();
            }
        }
        expect(windowsEntryKeys()).toEqual([]);
    });

    it("registers Chrome per user on Windows, which needs no administrator", () => {
        const entry = externalEntry("chrome", "win32", folders, listed);
        expect(entry).toEqual({ kind: "registry", key: `HKCU\\Software\\Google\\Chrome\\Extensions\\${id}`, updateUrl: CHROME_WEB_STORE_UPDATE });
        if (entry?.kind !== "registry") throw new Error("not a registry entry");
        // /f replaces the same entry rather than failing: running it twice is running it once.
        expect(registryAddLaunch(entry)).toEqual({
            file: "reg.exe",
            args: ["add", entry.key, "/v", "update_url", "/t", "REG_SZ", "/d", CHROME_WEB_STORE_UPDATE, "/f"]
        });
        expect(windowsEntryKeys(listed)).toEqual([entry.key]);
        expect(registryDeleteLaunch(entry.key)).toEqual({ file: "reg.exe", args: ["delete", entry.key, "/f"] });
    });

    it("writes Chrome's per-user file on macOS, and nothing on Linux, where only system folders count", () => {
        expect(externalEntry("chrome", "darwin", folders, listed)).toEqual({
            kind: "file",
            path: `/Users/me/Library/Application Support/Google/Chrome/External Extensions/${id}.json`,
            contents: `${JSON.stringify({ external_update_url: CHROME_WEB_STORE_UPDATE }, null, 4)}\n`
        });
        expect(externalEntry("chrome", "linux", folders, listed)).toBeNull();
    });

    it("uses Edge's documented per-user folders, and not its machine-wide Windows key", () => {
        const edge = "b".repeat(32);
        expect(externalEntry("edge", "win32", folders, listed)).toBeNull();
        expect(externalEntry("edge", "linux", { home: "/home/me" }, { chromeWebStore: null, edgeAddons: edge })).toEqual({
            kind: "file",
            path: `/home/me/.config/microsoft-edge/External Extensions/${edge}.json`,
            contents: `${JSON.stringify({ external_update_url: EDGE_ADDONS_UPDATE }, null, 4)}\n`
        });
        expect(externalEntry("edge", "darwin", folders, listed)).toMatchObject({
            path: `/Users/me/Library/Application Support/Microsoft Edge/External Extensions/${id}.json`
        });
    });

    it("leaves Brave and Opera to the unpacked way, having no documented entry", () => {
        expect(externalEntry("brave", "win32", folders, listed)).toBeNull();
        expect(externalEntry("opera", "darwin", folders, listed)).toBeNull();
    });

    it("refuses an id that is not one, so nothing odd reaches the registry", () => {
        expect(externalEntry("chrome", "win32", folders, { chromeWebStore: "x /f & calc", edgeAddons: null })).toBeNull();
    });

    it("opens the browser as it is, for the prompt it shows on opening", () => {
        expect(browserLaunch("chrome", "darwin")).toEqual({ file: "/usr/bin/open", args: ["-a", "Google Chrome"] });
        expect(browserLaunch("edge", "win32").args.at(-1)).toBe("Start-Process 'msedge'");
    });
});
