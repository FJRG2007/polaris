/**
 * The launcher's listing kept on disk, so the first open after a restart
 * answers at once: only a listing of this version and shape is trusted, and a
 * watched folder is read again once its changes settle, never put off forever.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    app: { getPath: vi.fn(() => "") },
    shell: { readShortcutLink: vi.fn(), openPath: vi.fn(), openExternal: vi.fn() }
}));

const { INDEX_VERSION, WATCH_MAX_MS, WATCH_SETTLE_MS, parseIndex, settleDelay } = await import("../../src/main/launcher-apps");

const listing = {
    version: INDEX_VERSION,
    at: 1_700_000_000_000,
    apps: [
        {
            label: "Grand Theft Auto V",
            path: "program:d:\\games\\gtav\\playgtav.exe",
            launch: { kind: "exe", path: "D:\\Games\\Launcher\\Launcher.exe", cwd: "D:\\Games\\Launcher", args: ["-launchTitleInFolder", "D:\\Games\\GTAV"] },
            aliases: ["GTAV"]
        },
        { label: "Dota 2", path: "steam:570", launch: { kind: "uri", uri: "steam://rungameid/570" } }
    ],
    games: [{ name: "Dota 2", folder: "D:\\Steam\\dota 2 beta", store: "steam:570" }]
};

describe("the listing kept on disk", () => {
    it("is read back as it was written", () => {
        expect(parseIndex(JSON.parse(JSON.stringify(listing)))).toEqual(listing);
    });

    it("is not trusted from another version or in another shape", () => {
        expect(parseIndex({ ...listing, version: INDEX_VERSION - 1 })).toBeNull();
        expect(parseIndex({ ...listing, apps: [{ label: "x", path: "y", launch: { kind: "shell", command: "calc" } }] })).toBeNull();
        expect(parseIndex({ ...listing, apps: [{ label: "", path: "y" }] })).toBeNull();
        expect(parseIndex(null)).toBeNull();
        expect(parseIndex("[]")).toBeNull();
    });
});

describe("a watched folder's changes", () => {
    it("are read once they settle, and no later than the longest wait after the first", () => {
        expect(settleDelay(1000, 1000)).toBe(WATCH_SETTLE_MS);
        expect(settleDelay(1000 + WATCH_MAX_MS - 1000, 1000)).toBe(1000);
        expect(settleDelay(1000 + WATCH_MAX_MS + 5000, 1000)).toBe(0);
    });
});
