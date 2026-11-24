/**
 * Opening with the computer is a preference: failing to write it never stops the
 * app, and the answer says whether it took.
 *
 * `schtasks` is never run for real: `node:child_process` is replaced, and a call no
 * test answered fails the test in `afterEach`, so nothing here can register a task
 * on the computer running the suite.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Callback = (error: Error | null) => void;

const electron = vi.hoisted(() => ({
    isPackaged: true,
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ wasOpenedAtLogin: false }))
}));

const scheduler = vi.hoisted(() => ({
    unanswered: [] as string[][],
    answer: null as ((args: string[]) => boolean) | null,
    calls: [] as string[][]
}));

vi.mock("electron", () => ({ app: electron }));
vi.mock("node:child_process", () => ({
    execFile: (_file: string, args: string[], _options: unknown, callback: Callback) => {
        scheduler.calls.push(args);
        if (!scheduler.answer) {
            scheduler.unanswered.push(args);
            callback(new Error("schtasks was not stubbed"));
            return;
        }
        callback(scheduler.answer(args) ? null : new Error("refused"));
    }
}));
vi.mock("node:os", async (original) => ({
    ...(await original<typeof import("node:os")>()),
    userInfo: () => ({ username: "fixture-user" })
}));

const { LOGIN_ARG, logonTaskName, logonTaskXml, setOpenAtLogin, startedAtLogin } = await import("@/main/login-item");
const platform = process.platform;
const config = process.env.XDG_CONFIG_HOME;
const domain = process.env.USERDOMAIN;

beforeEach(() => {
    electron.isPackaged = true;
    electron.setLoginItemSettings.mockClear();
    scheduler.answer = null;
    scheduler.calls = [];
    scheduler.unanswered = [];
    process.env.USERDOMAIN = "FIXTURE-PC";
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "polaris-autostart-"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    if (config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = config;
    if (domain === undefined) delete process.env.USERDOMAIN;
    else process.env.USERDOMAIN = domain;
    vi.restoreAllMocks();
    expect(scheduler.unanswered).toEqual([]);
});

function runEntry(): { openAtLogin: boolean; args: string[]; } | undefined {
    return electron.setLoginItemSettings.mock.lastCall?.[0];
}

describe("opening with the computer", () => {
    it("writes the entry and takes it away again", async () => {
        const entry = join(process.env.XDG_CONFIG_HOME ?? "", "autostart", "polaris.desktop");
        expect(await setOpenAtLogin(true)).toBe(true);
        expect(existsSync(entry)).toBe(true);
        expect(await setOpenAtLogin(false)).toBe(true);
        expect(existsSync(entry)).toBe(false);
    });

    it("answers false instead of throwing when the folder cannot be written", async () => {
        const blocked = join(process.env.XDG_CONFIG_HOME ?? "", "file");
        writeFileSync(blocked, "");
        process.env.XDG_CONFIG_HOME = blocked;
        expect(await setOpenAtLogin(true)).toBe(false);
    });

    it("marks the start the computer makes, so Start in the tray can tell it apart", async () => {
        const entry = join(process.env.XDG_CONFIG_HOME ?? "", "autostart", "polaris.desktop");
        await setOpenAtLogin(true);
        expect(readFileSync(entry, "utf8")).toMatch(new RegExp(`^Exec=".*" ${LOGIN_ARG}$`, "m"));
        expect(logonTaskXml("PC\\user", "C:\\app\\Update.exe", ["--processStart", "polaris.exe", "--process-start-args", LOGIN_ARG])).toContain(
            `<Arguments>&quot;--processStart&quot; &quot;polaris.exe&quot; &quot;--process-start-args&quot; &quot;${LOGIN_ARG}&quot;</Arguments>`
        );
    });

    it("tells a start at login from somebody opening the app", () => {
        expect(startedAtLogin(["polaris.exe", LOGIN_ARG])).toBe(true);
        expect(startedAtLogin(["polaris.exe"])).toBe(false);
        Object.defineProperty(process, "platform", { value: "darwin" });
        electron.getLoginItemSettings.mockReturnValueOnce({ wasOpenedAtLogin: true });
        expect(startedAtLogin(["Polaris"])).toBe(true);
    });

    it("leaves a development run alone", async () => {
        electron.isPackaged = false;
        Object.defineProperty(process, "platform", { value: "win32" });
        expect(await setOpenAtLogin(true)).toBe(true);
        expect(existsSync(join(process.env.XDG_CONFIG_HOME ?? "", "autostart"))).toBe(false);
        expect(scheduler.calls).toEqual([]);
        expect(electron.setLoginItemSettings).not.toHaveBeenCalled();
    });
});

describe("on Windows", () => {
    beforeEach(() => Object.defineProperty(process, "platform", { value: "win32" }));

    it("opens from a logon task and takes the Run key entry away, so it starts once", async () => {
        let xml = "";
        scheduler.answer = (args) => {
            const file = args[args.indexOf("/XML") + 1] ?? "";
            const bytes = readFileSync(file);
            expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
            xml = bytes.toString("utf16le");
            return true;
        };
        expect(await setOpenAtLogin(true)).toBe(true);
        expect(scheduler.calls).toEqual([["/Create", "/TN", logonTaskName("fixture-user"), "/XML", expect.any(String), "/F"]]);
        expect(existsSync(scheduler.calls[0]?.[4] ?? "")).toBe(false);
        expect(xml).toContain("<LogonTrigger><Enabled>true</Enabled><UserId>FIXTURE-PC\\fixture-user</UserId></LogonTrigger>");
        expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
        expect(xml).toContain("<Priority>5</Priority>");
        expect(xml).not.toContain("<Delay>");
        expect(xml).toMatch(/<Command>.*Update\.exe<\/Command>/);
        expect(runEntry()?.openAtLogin).toBe(false);
    });

    it("falls back to the Run key when Windows refuses the task", async () => {
        scheduler.answer = () => false;
        expect(await setOpenAtLogin(true)).toBe(true);
        expect(runEntry()?.openAtLogin).toBe(true);
        expect(runEntry()?.args).toContain(LOGIN_ARG);
    });

    it("turned off, removes both the task and the Run key entry", async () => {
        scheduler.answer = () => true;
        expect(await setOpenAtLogin(false)).toBe(true);
        expect(scheduler.calls).toEqual([["/Delete", "/TN", logonTaskName("fixture-user"), "/F"]]);
        expect(runEntry()?.openAtLogin).toBe(false);
    });

    it("turned off with no task to remove, still took", async () => {
        scheduler.answer = () => false;
        expect(await setOpenAtLogin(false)).toBe(true);
        expect(scheduler.calls.map((args) => args[0])).toEqual(["/Delete", "/Query"]);
    });

    it("says it did not take when a task stays behind", async () => {
        scheduler.answer = (args) => args[0] === "/Query";
        expect(await setOpenAtLogin(false)).toBe(false);
    });

    it("names one task per account, in a form Task Scheduler takes", () => {
        expect(logonTaskName("ana")).toBe("Polaris at sign-in (ana)");
        expect(logonTaskName("a/b:c")).toBe("Polaris at sign-in (a_b_c)");
        expect(logonTaskXml("PC\\a&b", "C:\\x\\Update.exe", [])).toContain("<UserId>PC\\a&amp;b</UserId>");
    });
});
