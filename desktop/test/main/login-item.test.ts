/**
 * Opening with the computer is a preference: failing to write it never stops the
 * app, and the answer says whether it took.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
    isPackaged: true,
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ wasOpenedAtLogin: false }))
}));

vi.mock("electron", () => ({ app: electron }));

const { LOGIN_ARG, setOpenAtLogin, startedAtLogin } = await import("@/main/login-item");
const platform = process.platform;
const config = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
    electron.isPackaged = true;
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "polaris-autostart-"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    if (config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = config;
    vi.restoreAllMocks();
});

describe("opening with the computer", () => {
    it("writes the entry and takes it away again", () => {
        const entry = join(process.env.XDG_CONFIG_HOME ?? "", "autostart", "polaris.desktop");
        expect(setOpenAtLogin(true)).toBe(true);
        expect(existsSync(entry)).toBe(true);
        expect(setOpenAtLogin(false)).toBe(true);
        expect(existsSync(entry)).toBe(false);
    });

    it("answers false instead of throwing when the folder cannot be written", () => {
        const blocked = join(process.env.XDG_CONFIG_HOME ?? "", "file");
        writeFileSync(blocked, "");
        process.env.XDG_CONFIG_HOME = blocked;
        expect(setOpenAtLogin(true)).toBe(false);
    });

    it("marks the start the computer makes, so Start minimized can tell it apart", () => {
        const entry = join(process.env.XDG_CONFIG_HOME ?? "", "autostart", "polaris.desktop");
        setOpenAtLogin(true);
        expect(readFileSync(entry, "utf8")).toMatch(new RegExp(`^Exec=".*" ${LOGIN_ARG}$`, "m"));
        Object.defineProperty(process, "platform", { value: "win32" });
        setOpenAtLogin(true);
        expect(electron.setLoginItemSettings.mock.lastCall?.[0].args).toContain(LOGIN_ARG);
    });

    it("tells a start at login from somebody opening the app", () => {
        expect(startedAtLogin(["polaris.exe", LOGIN_ARG])).toBe(true);
        expect(startedAtLogin(["polaris.exe"])).toBe(false);
        Object.defineProperty(process, "platform", { value: "darwin" });
        electron.getLoginItemSettings.mockReturnValueOnce({ wasOpenedAtLogin: true });
        expect(startedAtLogin(["Polaris"])).toBe(true);
    });

    it("leaves a development run alone", () => {
        electron.isPackaged = false;
        expect(setOpenAtLogin(true)).toBe(true);
        expect(existsSync(join(process.env.XDG_CONFIG_HOME ?? "", "autostart"))).toBe(false);
    });
});
