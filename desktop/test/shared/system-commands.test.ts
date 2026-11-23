import { describe, expect, it } from "vitest";
import { matchScore } from "@/shared/launcher";
import { searchableCommand, systemCommands } from "@/shared/system-commands";
import { SYSTEM_COMMAND_IDS } from "../../../dashboard/packages/core/src/launcher-commands";

const ids = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) => systemCommands(platform, env).map((command) => command.id);

describe("the launcher's system commands", () => {
    it("offers every command on Windows, by full path under SystemRoot", () => {
        const commands = systemCommands("win32", { SystemRoot: "D:\\Win" });
        expect(commands.map((command) => command.id)).toEqual([...SYSTEM_COMMAND_IDS]);
        for (const command of commands) expect(command.file.startsWith("D:\\Win\\System32\\")).toBe(true);
        expect(commands.find((command) => command.id === "restart")).toMatchObject({ file: "D:\\Win\\System32\\shutdown.exe", args: ["/r", "/t", "0"] });
    });

    it("falls back on the usual Windows folder", () => {
        expect(systemCommands("win32", {})[0]!.file).toBe("C:\\Windows\\System32\\rundll32.exe");
    });

    it("leaves lock out on macOS, which cannot trigger one without Accessibility", () => {
        expect(ids("darwin")).toEqual(["sleep", "restart", "shutdown", "logout", "empty-trash"]);
        expect(systemCommands("darwin", {}).find((command) => command.id === "empty-trash")?.label).toBe("Empty Trash");
    });

    it("logs out on Linux only when it knows the session", () => {
        expect(ids("linux")).not.toContain("logout");
        expect(ids("linux", { XDG_SESSION_ID: "c2; rm -rf /" })).not.toContain("logout");
        expect(systemCommands("linux", { XDG_SESSION_ID: "c2" }).find((command) => command.id === "logout")?.args).toEqual(["terminate-session", "c2"]);
    });

    it("offers nothing on a system it does not know", () => {
        expect(ids("aix")).toEqual([]);
    });

    it("asks first for what cannot be undone, never for lock or sleep", () => {
        const confirm = Object.fromEntries(systemCommands("win32", {}).map((command) => [command.id, command.confirm]));
        expect(confirm).toEqual({ lock: false, sleep: false, restart: true, shutdown: true, logout: true, "empty-trash": true });
    });

    it("is found by its other words", () => {
        const restart = systemCommands("linux", {}).find((command) => command.id === "restart")!;
        expect(matchScore("reboot", searchableCommand(restart))).toBeGreaterThan(0);
        expect(matchScore("rest", searchableCommand(restart))).toBe(80);
    });
});
