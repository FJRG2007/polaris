/**
 * Carries out what the person chose about the official Hercules software
 * (`hercules-official.ts` decides the steps): looks at the machine, keeps a
 * copy of what it is about to change, stops Stream Control, takes it out of
 * "start with Windows", runs the vendor's own signed uninstaller, and puts it
 * all back on "Restore the official app".
 *
 * Every program is started by its absolute path with an argument array, never
 * through a shell, and nothing typed by anyone reaches a command line: the
 * values a PowerShell step needs travel in its environment. Everything that
 * touches the machine is passed in (`OfficialHost`), so the order of the steps
 * and every refusal are tested with fakes; nothing here runs on its own.
 */

import { z } from "zod";
import { join } from "node:path";
import * as official from "./hercules-official";

/** What a program printed and how it ended. */
export interface RunResult {
    readonly code: number;
    readonly stdout: string;
}

/** The machine, as the steps reach it. */
export interface OfficialHost {
    /** `file` by absolute path, `args` as an array; `env` is added to the app's own. Never throws: a program that did not start answers code -1. */
    run(file: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<RunResult>;
    /** Starts a program and does not wait for it; false when it did not start. */
    launch(file: string): Promise<boolean>;
    readText(path: string, maxBytes: number): Promise<string | null>;
    writeText(path: string, text: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    sleep(ms: number): Promise<void>;
}

/** Where Windows keeps things on this machine (`%SystemRoot%`, `%ProgramFiles(x86)%`, `%APPDATA%`). */
export interface OfficialPaths {
    readonly systemRoot: string;
    readonly programFilesX86: string;
    readonly appData: string;
    /** The add-on's own data folder, where the copy is kept (survives uninstalling the add-on). */
    readonly dataDir: string;
}

const UNINSTALL_KEYS = [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];
const RUN_KEYS = [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
];
/** Stream Control's settings file is small; anything past this is not it. */
export const MAX_INI_BYTES = 2 * 1024 * 1024;
/** Keys of the settings file that hold the person's Discord, Spotify, Streamlabs and OBS sign-ins. */
const SECRET_KEY = /(token|secret|password)/i;
/** Exit code PowerShell is told to answer when the person said no to Windows' administrator prompt. */
export const DECLINED = 1223;

const tool = (paths: OfficialPaths, name: string) => `${paths.systemRoot}\\System32\\${name}`;
const powershell = (paths: Pick<OfficialPaths, "systemRoot">) => `${paths.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
export const iniPath = (paths: OfficialPaths) => join(paths.appData, "Hercules", "Stream Control", "Stream Control.ini");
export const backupPath = (paths: OfficialPaths) => join(paths.dataDir, "official-software.json");

/**
 * Quotes one argument so `CommandLineToArgvW` reads it back unchanged (the
 * inverse of `splitCommandLine`): backslashes are doubled only before a quote.
 */
export function quoteWindowsArg(arg: string): string {
    if (arg && !/[\s"]/.test(arg)) return arg;
    let out = "\"";
    for (let i = 0; i < arg.length; i++) {
        let slashes = 0;
        while (arg[i] === "\\") {
            slashes++;
            i++;
        }
        if (i === arg.length) out += "\\".repeat(slashes * 2);
        else if (arg[i] === "\"") out += `${"\\".repeat(slashes * 2 + 1)}"`;
        else out += `${"\\".repeat(slashes)}${arg[i]}`;
    }
    return `${out}"`;
}

/** The settings file with every sign-in line taken out, in any section. */
export function withoutSecrets(text: string): string {
    return text
        .slice(0, MAX_INI_BYTES)
        .split(/\r?\n/)
        .filter((line) => {
            const eq = line.indexOf("=");
            return eq <= 0 || /^\s*\[/.test(line) || !SECRET_KEY.test(line.slice(0, eq));
        })
        .join("\r\n");
}

/**
 * The copy put back over the file as it is now: the copy has no sign-ins, so
 * the ones the file holds today go back into their own sections, and nobody
 * has to sign in to Discord or OBS again.
 */
export function restoreIni(copy: string, current: string | null): string {
    const secrets = new Map<string, string[]>();
    if (current) {
        let section = "General";
        for (const line of current.slice(0, MAX_INI_BYTES).split(/\r?\n/)) {
            const head = /^\[(.+)\]\s*$/.exec(line);
            if (head) section = head[1] ?? "";
            else if (line.indexOf("=") > 0 && SECRET_KEY.test(line.slice(0, line.indexOf("=")))) secrets.set(section, [...(secrets.get(section) ?? []), line]);
        }
    }
    const out: string[] = [];
    let section = "General";
    const flush = () => {
        out.push(...(secrets.get(section) ?? []));
        secrets.delete(section);
    };
    for (const line of copy.split(/\r?\n/)) {
        const head = /^\[(.+)\]\s*$/.exec(line);
        if (head) {
            while (out.length && out.at(-1) === "") out.pop();
            flush();
            if (out.length) out.push("");
            section = head[1] ?? "";
        }
        out.push(line);
    }
    while (out.length && out.at(-1) === "") out.pop();
    flush();
    for (const [name, lines] of secrets) out.push("", `[${name}]`, ...lines);
    return `${out.join("\r\n")}\r\n`;
}

const signatureSchema = z.object({ Status: z.string().max(40), Subject: z.string().max(1_000).nullable().catch(null) });

/** What `Get-AuthenticodeSignature` said about a file, or null when it said nothing readable. */
export function readSignature(stdout: string): { status: string; subject: string; } | null {
    try {
        const parsed = signatureSchema.safeParse(JSON.parse(stdout.trim()));
        return parsed.success ? { status: parsed.data.Status, subject: parsed.data.Subject ?? "" } : null;
    } catch {
        return null;
    }
}

/** A valid Authenticode signature whose signer's common or organization name is Hercules' parent company. */
export function signatureAccepted(signature: { status: string; subject: string; } | null): boolean {
    if (!signature || signature.status !== "Valid") return false;
    const signer = official.HERCULES_SIGNER.split(" ")[0] ?? official.HERCULES_SIGNER;
    return new RegExp(`(^|,)\\s*(CN|O)="?${signer}\\b`, "i").test(signature.subject);
}

/**
 * The Stream Control program a Run value starts, or null when it is not an
 * absolute path ending in `Stream-control.exe` with no way out of its folder.
 * The value is unquoted with spaces, so the path is everything up to the image.
 */
export function officialProgram(entry: official.AutostartEntry): string | null {
    const match = /^\s*"?([A-Za-z]:\\[^"*?<>|\0-\x1f]*?\\Stream-control\.exe)"?(\s|$)/i.exec(entry.command);
    const file = match?.[1];
    return file && !file.split("\\").includes("..") ? file : null;
}

const SIGNATURE_SCRIPT = [
    "$ErrorActionPreference='Stop'; $s = Get-AuthenticodeSignature -LiteralPath $env:POLARIS_TARGET;",
    "[pscustomobject]@{ Status = $s.Status.ToString(); Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress"
].join(" ");
/** Starts a program through Windows' administrator prompt and answers its exit code; 1223 when the prompt was declined. */
const ELEVATED_SCRIPT = [
    "try { $a = @{ FilePath = $env:POLARIS_FILE; Verb = 'RunAs'; Wait = $true; PassThru = $true };",
    "if ($env:POLARIS_ARGS) { $a.ArgumentList = $env:POLARIS_ARGS }; $p = Start-Process @a; exit $p.ExitCode }",
    "catch { if ($_.Exception.InnerException.NativeErrorCode -eq 1223 -or $_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }"
].join(" ");

/**
 * Runs `file` with `args` through Windows' administrator prompt and answers
 * its exit code; [`DECLINED`] when the prompt was declined. The file and its
 * arguments travel in the environment, never in a command line built here.
 */
export async function runElevated(host: Pick<OfficialHost, "run">, systemRoot: string, file: string, args: readonly string[]): Promise<number> {
    const env: Record<string, string> = { POLARIS_FILE: file };
    if (args.length) env.POLARIS_ARGS = args.map(quoteWindowsArg).join(" ");
    return (await host.run(powershell({ systemRoot }), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ELEVATED_SCRIPT], env)).code;
}

/** What the add-on keeps before it changes anything, and what "Restore" puts back. */
const backupSchema = z.object({
    version: z.literal(1),
    at: z.string().max(40),
    choice: z.enum(["stop", "uninstall", "keep"]),
    autostart: z
        .array(z.object({ hive: z.enum(["HKCU", "HKLM"]), key: z.string().max(300), name: z.string().max(200), command: z.string().max(1_000) }))
        .max(16),
    ini: z.string().max(MAX_INI_BYTES).nullable(),
    restored: z.boolean().default(false)
});

export type OfficialBackup = z.infer<typeof backupSchema>;

export interface OfficialLook {
    readonly found: official.OfficialSoftware | null;
    readonly imported: official.StreamControlImport | null;
}

export type StepFailure = "stopProcess" | "removeAutostart" | "unsigned" | "declined" | "uninstaller";

export type ExecuteResult =
    | { readonly ok: true; readonly values: Readonly<Record<string, string>>; readonly layout: official.Layout | null; readonly install: boolean; }
    | { readonly ok: false; readonly reason: "cancelled" | "uninstallerRefused" | "nothingToUninstall" | StepFailure; };

export interface RestoreResult {
    readonly ok: boolean;
    /** Run values put back. */
    readonly autostart: number;
    readonly settings: boolean;
    readonly started: boolean;
    /** Stream Control is no longer installed: only its settings could go back. */
    readonly missing: boolean;
    readonly declined: boolean;
}

export function createOfficialRunner(host: OfficialHost, paths: OfficialPaths, now: () => Date = () => new Date()) {
    const reg = (args: readonly string[]) => host.run(tool(paths, "reg.exe"), args);

    const elevated = (file: string, args: readonly string[]) => runElevated(host, paths.systemRoot, file, args);

    async function running(): Promise<boolean> {
        const out = await host.run(tool(paths, "tasklist.exe"), ["/fo", "csv", "/nh", "/fi", `IMAGENAME eq ${official.STREAM_CONTROL_IMAGE}`]);
        return out.code === 0 && out.stdout.toLowerCase().includes(`"${official.STREAM_CONTROL_IMAGE.toLowerCase()}"`);
    }

    async function look(): Promise<OfficialLook> {
        const texts = await Promise.all([...UNINSTALL_KEYS, ...RUN_KEYS].map(async (key) => {
            const out = await reg(["query", key, "/s"]);
            return out.code === 0 ? out.stdout : "";
        }));
        const tasks = await host.run(tool(paths, "tasklist.exe"), ["/fo", "csv", "/nh", "/fi", `IMAGENAME eq ${official.STREAM_CONTROL_IMAGE}`]);
        const found = official.findOfficial(official.parseRegQuery(texts.join("\r\n")), tasks.code === 0 ? tasks.stdout : "");
        const ini = await host.readText(iniPath(paths), MAX_INI_BYTES);
        return { found, imported: ini ? official.importStreamControl(ini) : null };
    }

    async function readBackup(): Promise<OfficialBackup | null> {
        const text = await host.readText(backupPath(paths), MAX_INI_BYTES * 2);
        if (!text) return null;
        try {
            const parsed = backupSchema.safeParse(JSON.parse(text));
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }

    /**
     * Keeps a copy before any step: the first copy is the machine before
     * Polaris, so a later choice adds the Run values it removes and keeps the
     * settings file the first one saved.
     */
    async function keepCopy(choice: Exclude<official.OfficialChoice, "cancel">, found: official.OfficialSoftware): Promise<void> {
        const previous = await readBackup();
        const ini = await host.readText(iniPath(paths), MAX_INI_BYTES);
        const autostart = [...(previous && !previous.restored ? previous.autostart : [])];
        for (const entry of found.autostart) if (!autostart.some((kept) => kept.key === entry.key && kept.name === entry.name)) autostart.push({ ...entry });
        const backup: OfficialBackup = {
            version: 1,
            at: now().toISOString(),
            choice,
            autostart: autostart.slice(0, 16),
            ini: previous && !previous.restored && previous.ini !== null ? previous.ini : ini ? withoutSecrets(ini) : null,
            restored: false
        };
        await host.writeText(backupPath(paths), JSON.stringify(backup));
    }

    async function stopProcess(): Promise<boolean> {
        // Asked to close first, the way closing its window would; forced only
        // when it is still there a few seconds later.
        for (const force of [false, true]) {
            await host.run(tool(paths, "taskkill.exe"), force ? ["/f", "/im", official.STREAM_CONTROL_IMAGE] : ["/im", official.STREAM_CONTROL_IMAGE]);
            for (let tries = 0; tries < 10; tries++) {
                if (!(await running())) return true;
                await host.sleep(500);
            }
        }
        return false;
    }

    async function autostartGone(entry: official.AutostartEntry): Promise<boolean> {
        return (await reg(["query", entry.key.replace(/^HKEY_LOCAL_MACHINE/, "HKLM").replace(/^HKEY_CURRENT_USER/, "HKCU"), "/v", entry.name])).code !== 0;
    }

    async function removeAutostart(entry: official.AutostartEntry, elevate: boolean): Promise<StepFailure | null> {
        const args = ["delete", entry.key, "/v", entry.name, "/f"];
        if (elevate) {
            const code = await elevated(tool(paths, "reg.exe"), args);
            if (code === DECLINED) return "declined";
        } else await reg(args);
        return (await autostartGone(entry)) ? null : "removeAutostart";
    }

    async function signed(file: string): Promise<boolean> {
        const out = await host.run(powershell(paths), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SIGNATURE_SCRIPT], { POLARIS_TARGET: file });
        return out.code === 0 && signatureAccepted(readSignature(out.stdout));
    }

    async function step(item: official.OfficialStep): Promise<StepFailure | null> {
        switch (item.kind) {
            case "importSettings":
            case "installAddon":
                return null;
            case "stopProcess":
                return (await stopProcess()) ? null : "stopProcess";
            case "removeAutostart":
                return removeAutostart(item.entry, item.elevated);
            case "runUninstaller": {
                if (!(await host.exists(item.file)) || !(await signed(item.file))) return "unsigned";
                const code = await elevated(item.file, item.args);
                return code === DECLINED ? "declined" : code === 0 ? null : "uninstaller";
            }
        }
    }

    /** The Stream Control program to start: from a Run value now, or from the copy. */
    async function program(): Promise<string | null> {
        const { found } = await look();
        const entries = [...(found?.autostart ?? []), ...((await readBackup())?.autostart ?? [])];
        for (const entry of entries) {
            const file = officialProgram(entry);
            if (file && (await host.exists(file))) return file;
        }
        return null;
    }

    return {
        look,
        readBackup,

        /** Carries out one choice. Settings are imported and a copy is kept before anything is stopped or removed. */
        async execute(choice: official.OfficialChoice): Promise<ExecuteResult> {
            const { found, imported } = await look();
            if (choice === "cancel") return { ok: false, reason: "cancelled" };
            const values = imported?.values ?? {};
            const layout = imported?.layout ?? null;
            if (!found) return { ok: true, values, layout, install: true };
            const plan = official.planChoice(choice, found, paths.programFilesX86);
            if (!plan.ok) return { ok: false, reason: plan.reason };
            await keepCopy(choice, found);
            for (const item of plan.steps) {
                const failed = await step(item);
                if (failed) return { ok: false, reason: failed };
            }
            return { ok: true, values, layout, install: true };
        },

        /** Puts back the Run values and the settings file, and starts Stream Control again when it is still installed. */
        async restore(): Promise<RestoreResult> {
            const backup = await readBackup();
            const result = { ok: false, autostart: 0, settings: false, started: false, missing: false, declined: false };
            if (!backup) return result;
            let anyProgram = false;
            for (const entry of backup.autostart) {
                const file = officialProgram(entry);
                if (!file || !(await host.exists(file))) continue;
                anyProgram = true;
                if (!(await autostartGone(entry))) continue;
                const args = ["add", entry.key, "/v", entry.name, "/t", "REG_SZ", "/d", entry.command, "/f"];
                if (entry.hive === "HKLM") {
                    if ((await elevated(tool(paths, "reg.exe"), args)) === DECLINED) return { ...result, declined: true };
                } else await reg(args);
                if (!(await autostartGone(entry))) result.autostart++;
            }
            if (backup.ini !== null) {
                await host.writeText(iniPath(paths), restoreIni(backup.ini, await host.readText(iniPath(paths), MAX_INI_BYTES)));
                result.settings = true;
            }
            const file = await program();
            result.missing = !file && !anyProgram;
            if (file && !(await running())) result.started = await host.launch(file);
            await host.writeText(backupPath(paths), JSON.stringify({ ...backup, restored: true }));
            return { ...result, ok: true };
        },

        /** Starts Stream Control from where its Run value points, and nothing else. */
        async launch(): Promise<boolean> {
            const file = await program();
            return file ? host.launch(file) : false;
        }
    };
}

export type OfficialRunner = ReturnType<typeof createOfficialRunner>;

