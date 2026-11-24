/**
 * BUG-0020: a link a browser started by Polaris turned down is handed to the
 * desktop's Explorer, which starts the browser outside Polaris's process tree.
 * `spawn` is a recorder here, so no Explorer and no browser is ever started.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawned: { file: string; args: string[]; options: Record<string, unknown>; }[] = [];
vi.mock("node:child_process", () => ({
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
        spawned.push({ file, args, options });
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        setImmediate(() => child.emit("spawn"));
        return child;
    }
}));
vi.mock("node:fs", () => ({ existsSync: (path: string) => path === String.raw`C:\Windows\explorer.exe` }));

const { handToShell, ShellUnavailable } = await import("../../src/main/default-browser");

const ENV = { SystemRoot: String.raw`C:\Windows`, PATH: String.raw`C:\Windows`, CHROME_CRASHPAD_PIPE_NAME: "x", ELECTRON_RUN_AS_NODE: "1" };

describe("handToShell", () => {
    it("starts the system's Explorer with the address as one quoted argument, detached, without Electron's variables", async () => {
        spawned.length = 0;
        await expect(handToShell("https://github.com/a?b=1&c=%22#d", ENV)).resolves.toBeUndefined();
        expect(spawned).toHaveLength(1);
        const [call] = spawned;
        expect(call!.file).toBe(String.raw`C:\Windows\explorer.exe`);
        expect(call!.args).toEqual(["\"https://github.com/a?b=1&c=%22#d\""]);
        expect(call!.options).toMatchObject({ detached: true, stdio: "ignore", windowsVerbatimArguments: true });
        expect(call!.options.env).toEqual({ SystemRoot: String.raw`C:\Windows`, PATH: String.raw`C:\Windows` });
    });

    it("leaves an address Explorer would split, or one that could close its quotes, to the next route", async () => {
        spawned.length = 0;
        for (const url of ["mailto:a@example.com,b@example.com", "https://example.com/\" x", "https://example.com/a b"])
            await expect(handToShell(url, ENV)).rejects.toBeInstanceOf(ShellUnavailable);
        expect(spawned).toHaveLength(0);
    });

    it("leaves it to the next route where Explorer is not there", async () => {
        await expect(handToShell("https://example.com/", { SystemRoot: String.raw`D:\Nowhere` })).rejects.toBeInstanceOf(ShellUnavailable);
    });
});
