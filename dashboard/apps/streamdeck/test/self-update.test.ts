/**
 * "Update now" asks the scheduler to run the install line's own job, so the
 * run outlives this plugin when the job closes the Stream Deck app.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_RUN_MS, updateCommand, updateState, updaterPath } from "../src/self-update";

describe("updaterPath", () => {
    it("is where install.ps1 and install.sh keep their updater", () => {
        expect(updaterPath("win32", { LOCALAPPDATA: String.raw`C:\Users\ada\AppData\Local` })).toBe(
            join(String.raw`C:\Users\ada\AppData\Local`, "Polaris", "streamdeck", "update.ps1")
        );
        expect(updaterPath("darwin", { HOME: "/Users/ada" })).toBe(
            join("/Users/ada", "Library", "Application Support", "Polaris", "streamdeck", "update.sh")
        );
    });

    it("is none where the install line has nothing, or the folder is unknown", () => {
        expect(updaterPath("linux", { HOME: "/home/ada" })).toBeNull();
        expect(updaterPath("win32", {})).toBeNull();
    });
});

describe("updateCommand", () => {
    it("runs the task and the launchd job the install scripts register, by name", () => {
        expect(updateCommand("win32", null)).toEqual({
            file: "schtasks.exe",
            args: ["/Run", "/TN", "Polaris Stream Deck updates"]
        });
        expect(updateCommand("darwin", 501)).toEqual({
            file: "launchctl",
            args: ["kickstart", "gui/501/polaris-streamdeck-update"]
        });
        expect(updateCommand("linux", 1000)).toBeNull();
    });
});

describe("updateState", () => {
    it("is under way until the job's time limit, then failed so Downloads shows again", () => {
        expect(updateState(null, 0)).toBe("idle");
        expect(updateState({ ok: false, at: 0 }, 0)).toBe("failed");
        expect(updateState({ ok: true, at: 0 }, UPDATE_RUN_MS - 1)).toBe("started");
        expect(updateState({ ok: true, at: 0 }, UPDATE_RUN_MS)).toBe("failed");
    });
});
