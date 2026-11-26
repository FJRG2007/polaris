import { describe, expect, it } from "vitest";
import * as run from "@/main/plugins/hercules-official-run";
import { splitCommandLine } from "@/main/plugins/hercules-official";

const BS = String.fromCharCode(92);
const p = (...parts: string[]) => parts.join(BS);
const X86 = p("C:", "Program Files (x86)");
const APP_KEY = "{4E736157-448C-4D22-BF3F-1C58BE6E9B9E}";
const SETUP = p(X86, "InstallShield Installation Information", APP_KEY, "setup.exe");
const EXE = p("C:", "Program Files", "Hercules", "Hercules Stream Control", "Stream-control.exe");
const RUN_KEY = p("HKEY_LOCAL_MACHINE", "Software", "Microsoft", "Windows", "CurrentVersion", "Run");
const UNINSTALL = p("HKEY_LOCAL_MACHINE", "Software", "WOW6432Node", "Microsoft", "Windows", "CurrentVersion", "Uninstall", APP_KEY);
const PATHS: run.OfficialPaths = { systemRoot: p("C:", "Windows"), programFilesX86: X86, appData: p("C:", "Users", "someone", "AppData", "Roaming"), dataDir: p("C:", "data", "official", "hercules-stream100") };
const INI = ["[General]", "SpotifyToken=fixture-token", "OBSPassword=fixture-pass", "first_time=false", "", "[Device_SN_0]", "pageNumber=1", "discordSecret=fixture-secret", ""].join("\r\n");

interface Call {
    readonly tool: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
}

/** A Windows machine with Stream Control installed, running and starting with Windows, as far as the runner can see. */
function machine(options: { signature?: string; declineElevation?: boolean; closesOnAsk?: boolean; uninstallCode?: number; } = {}) {
    const calls: Call[] = [];
    const files = new Map<string, string>([[run.iniPath(PATHS), INI]]);
    const existing = new Set([SETUP, EXE]);
    const state = { running: true, autostart: true, launched: [] as string[] };
    const name = (file: string) => file.slice(file.lastIndexOf(BS) + 1).toLowerCase();
    const regText = () =>
        [
            UNINSTALL,
            "    DisplayName    REG_SZ    Hercules Stream Control",
            "    Publisher    REG_SZ    Hercules",
            `    UninstallString    REG_SZ    "${SETUP}" -runfromtemp -l0x0409 -removeonly`,
            "",
            RUN_KEY,
            ...(state.autostart ? [`    Hercules-Stream-Control    REG_SZ    ${EXE} -minimized`] : []),
            ""
        ].join("\r\n");
    const reg = (args: readonly string[]): run.RunResult => {
        if (args[0] === "query" && args[2] === "/s") return { code: 0, stdout: args[1]?.endsWith("Run") && args[1].startsWith("HKLM\\Software\\Microsoft") ? regText().slice(regText().indexOf(RUN_KEY)) : args[1]?.includes("WOW6432Node") && args[1].endsWith("Uninstall") ? regText() : "" };
        if (args[0] === "query") return { code: state.autostart ? 0 : 1, stdout: "" };
        if (args[0] === "delete") state.autostart = false;
        if (args[0] === "add") state.autostart = true;
        return { code: 0, stdout: "" };
    };
    const host: run.OfficialHost = {
        async run(file, args, env) {
            calls.push({ tool: name(file), args, env });
            switch (name(file)) {
                case "reg.exe":
                    return reg(args);
                case "tasklist.exe":
                    return { code: 0, stdout: state.running ? "\"Stream-control.exe\",\"4242\",\"Console\",\"1\",\"90,000 K\"\r\n" : "INFO: No tasks are running which match the specified criteria.\r\n" };
                case "taskkill.exe":
                    if (args.includes("/f") || options.closesOnAsk !== false) state.running = false;
                    return { code: 0, stdout: "" };
                case "powershell.exe": {
                    if (env?.POLARIS_TARGET) return { code: 0, stdout: options.signature ?? "{\"Status\":\"Valid\",\"Subject\":\"CN=Guillemot Corporation, O=Guillemot Corporation, L=Carentoir, C=FR\"}" };
                    if (options.declineElevation) return { code: run.DECLINED, stdout: "" };
                    if (name(env?.POLARIS_FILE ?? "") === "reg.exe") return reg(splitCommandLine(env?.POLARIS_ARGS ?? ""));
                    return { code: options.uninstallCode ?? 0, stdout: "" };
                }
                default:
                    return { code: -1, stdout: "" };
            }
        },
        async launch(file) {
            state.launched.push(file);
            state.running = true;
            return true;
        },
        readText: async (path) => files.get(path) ?? null,
        writeText: async (path, text) => {
            files.set(path, text);
        },
        exists: async (path) => existing.has(path),
        sleep: async () => undefined
    };
    return { calls, files, state, existing, runner: run.createOfficialRunner(host, PATHS, () => new Date("2026-11-24T10:00:00Z")) };
}

describe("quoting for Windows", () => {
    it("round-trips through CommandLineToArgvW's rules", () => {
        for (const arg of ["plain", "with space", "", "trailing\\", "quote\"inside", "a\\\\\"b", RUN_KEY, `${EXE} -minimized`]) {
            expect(splitCommandLine(run.quoteWindowsArg(arg))).toEqual([arg]);
        }
    });
});

describe("the settings copy", () => {
    it("never keeps a sign-in", () => {
        const copy = run.withoutSecrets(INI);
        expect(copy).not.toMatch(/fixture-(token|pass|secret)/);
        expect(copy).toContain("pageNumber=1");
        expect(copy).toContain("[Device_SN_0]");
    });

    it("puts today's sign-ins back into their own sections on restore", () => {
        const restored = run.restoreIni(run.withoutSecrets(INI), INI.replace("fixture-token", "newer-token"));
        expect(restored).toContain("newer-token");
        expect(restored).toContain("fixture-secret");
        const general = restored.slice(0, restored.indexOf("[Device_SN_0]"));
        expect(general).toContain("SpotifyToken=newer-token");
        expect(restored.slice(restored.indexOf("[Device_SN_0]"))).toContain("discordSecret=fixture-secret");
    });
});

describe("the uninstaller's signature", () => {
    it("accepts a valid signature by Guillemot only", () => {
        expect(run.signatureAccepted({ status: "Valid", subject: "CN=Guillemot Corporation, O=Guillemot Corporation, C=FR" })).toBe(true);
        expect(run.signatureAccepted({ status: "HashMismatch", subject: "CN=Guillemot Corporation" })).toBe(false);
        expect(run.signatureAccepted({ status: "Valid", subject: "CN=Not Guillemot Ltd, O=Example" })).toBe(false);
        expect(run.signatureAccepted({ status: "Valid", subject: "CN=GuillemotX" })).toBe(false);
        expect(run.signatureAccepted(run.readSignature("not json"))).toBe(false);
    });

    it("refuses to run an uninstaller that is not signed by Guillemot, after the copy and before anything is removed", async () => {
        const { runner, calls, state, files } = machine({ signature: "{\"Status\":\"NotSigned\",\"Subject\":null}" });
        expect(await runner.execute("uninstall")).toEqual({ ok: false, reason: "unsigned" });
        expect(files.has(run.backupPath(PATHS))).toBe(true);
        expect(calls.some((c) => c.env?.POLARIS_FILE === SETUP)).toBe(false);
        expect(state.running).toBe(false);
    });

    it("passes the path in the environment, never in the command", async () => {
        const { runner, calls } = machine();
        await runner.execute("uninstall");
        const check = calls.find((c) => c.env?.POLARIS_TARGET);
        expect(check?.env?.POLARIS_TARGET).toBe(SETUP);
        expect(check?.args.join(" ")).not.toContain("InstallShield");
        const elevated = calls.find((c) => c.env?.POLARIS_FILE === SETUP);
        expect(splitCommandLine(elevated?.env?.POLARIS_ARGS ?? "")).toEqual(["-runfromtemp", "-l0x0409", "-removeonly"]);
    });
});

describe("carrying out a choice", () => {
    it("keeps a copy, asks Stream Control to close, and takes it out of start with Windows through the administrator prompt", async () => {
        const { runner, calls, state, files } = machine();
        const done = await runner.execute("stop");
        expect(done.ok).toBe(true);
        expect(state.running).toBe(false);
        expect(state.autostart).toBe(false);
        expect(calls.find((c) => c.tool === "taskkill.exe")?.args).toEqual(["/im", "Stream-control.exe"]);
        expect(calls.some((c) => c.tool === "taskkill.exe" && c.args.includes("/f"))).toBe(false);
        const backup = JSON.parse(files.get(run.backupPath(PATHS)) ?? "{}");
        expect(backup).toMatchObject({ choice: "stop", autostart: [{ hive: "HKLM", name: "Hercules-Stream-Control" }] });
        expect(backup.ini).not.toContain("fixture-token");
        expect(calls.findIndex((c) => c.tool === "taskkill.exe")).toBeGreaterThan(-1);
    });

    it("forces Stream Control closed only when it stays open", async () => {
        const { runner, calls } = machine({ closesOnAsk: false });
        await runner.execute("stop");
        expect(calls.filter((c) => c.tool === "taskkill.exe").map((c) => c.args)).toEqual([["/im", "Stream-control.exe"], ["/f", "/im", "Stream-control.exe"]]);
    });

    it("stops with nothing removed when the administrator prompt is declined", async () => {
        const { runner, state } = machine({ declineElevation: true });
        expect(await runner.execute("stop")).toEqual({ ok: false, reason: "declined" });
        expect(state.autostart).toBe(true);
    });

    it("keeps everything on keep, and only notes the choice", async () => {
        const { runner, calls, state, files } = machine();
        expect((await runner.execute("keep")).ok).toBe(true);
        expect(state.running && state.autostart).toBe(true);
        expect(calls.some((c) => c.tool === "taskkill.exe" || c.env?.POLARIS_FILE)).toBe(false);
        expect(JSON.parse(files.get(run.backupPath(PATHS)) ?? "{}").choice).toBe("keep");
    });

    it("runs nothing on cancel", async () => {
        const { runner, files } = machine();
        expect(await runner.execute("cancel")).toEqual({ ok: false, reason: "cancelled" });
        expect(files.has(run.backupPath(PATHS))).toBe(false);
    });

    it("reports a failed uninstaller", async () => {
        const { runner } = machine({ uninstallCode: 1603 });
        expect(await runner.execute("uninstall")).toEqual({ ok: false, reason: "uninstaller" });
    });
});

describe("restoring the official app", () => {
    it("puts start with Windows and the settings back, keeps today's sign-ins, and starts it", async () => {
        const { runner, state, files } = machine();
        await runner.execute("stop");
        files.set(run.iniPath(PATHS), INI.replace("pageNumber=1", "pageNumber=9"));
        const result = await runner.restore();
        expect(result).toMatchObject({ ok: true, autostart: 1, settings: true, started: true, missing: false });
        expect(state.autostart).toBe(true);
        expect(state.launched).toEqual([EXE]);
        const ini = files.get(run.iniPath(PATHS)) ?? "";
        expect(ini).toContain("pageNumber=1");
        expect(ini).toContain("SpotifyToken=fixture-token");
        expect(JSON.parse(files.get(run.backupPath(PATHS)) ?? "{}").restored).toBe(true);
    });

    it("says the app is gone when it was uninstalled, and puts only the settings back", async () => {
        const { runner, existing, state } = machine();
        await runner.execute("stop");
        existing.delete(EXE);
        expect(await runner.restore()).toMatchObject({ ok: true, autostart: 0, settings: true, started: false, missing: true });
        expect(state.autostart).toBe(false);
    });

    it("answers not ok with nothing to restore", async () => {
        expect((await machine().runner.restore()).ok).toBe(false);
    });
});

describe("starting the official app", () => {
    it("starts only the Stream-control.exe its Run value names", async () => {
        const { runner, state } = machine();
        expect(await runner.launch()).toBe(true);
        expect(state.launched).toEqual([EXE]);
    });

    it("refuses a Run value that is not an absolute Stream-control.exe path", () => {
        const entry = (command: string) => ({ hive: "HKCU" as const, key: RUN_KEY, name: "x", command });
        expect(run.officialProgram(entry(`${EXE} -minimized`))).toBe(EXE);
        expect(run.officialProgram(entry(`"${EXE}"`))).toBe(EXE);
        expect(run.officialProgram(entry("Stream-control.exe"))).toBeNull();
        expect(run.officialProgram(entry(p("C:", "x", "..", "Stream-control.exe")))).toBeNull();
        expect(run.officialProgram(entry(p("C:", "x", "Stream-control.exe.bat")))).toBeNull();
        expect(run.officialProgram(entry(`cmd /c ${EXE}`))).toBeNull();
    });
});
