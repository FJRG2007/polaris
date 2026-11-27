/**
 * The official software of the devices plugins drive, as the install dialog
 * and a plugin's page reach it (`window.polarisDesktop.plugins.official`).
 * Only Hercules' Stream Control is known today, on Windows only; every other
 * plugin and platform is answered null and nothing runs.
 */

import { z } from "zod";
import { join } from "node:path";
import type { PluginManager } from "./manager";
import { createUdevRunner } from "./hercules-udev";
import { spawn, execFile } from "node:child_process";
import { access, mkdir, open, rename, writeFile } from "node:fs/promises";
import { PLUGIN_PERMISSIONS, type PluginSettingValue } from "@polaris/core/device-plugins";
import { createOfficialRunner, type OfficialHost, type OfficialRunner } from "./hercules-official-run";
import { createDriverRunner, type DriverFailure, type DriverOutcome, type DriverRunner, type DriverState } from "./hercules-driver";

/** The plugins whose device ships official software Polaris knows how to find. */
export const OFFICIAL_PLUGINS = ["hercules-stream100"] as const;

export const officialRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("look") }),
    z.object({ kind: z.literal("choose"), choice: z.enum(["stop", "uninstall", "keep"]), accepted: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length) }),
    z.object({ kind: z.literal("restore") }),
    z.object({ kind: z.literal("launch") })
]);

export type OfficialRequest = z.infer<typeof officialRequestSchema>;

async function readCapped(path: string, maxBytes: number): Promise<string | null> {
    const file = await open(path, "r").catch(() => null);
    if (!file) return null;
    try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await file.close();
    }
}

/** The machine for real: no shell, absolute paths, a size cap on everything read. */
export function nodeOfficialHost(): OfficialHost {
    return {
        run: (file, args, env) =>
            new Promise((done) => {
                execFile(file, [...args], { windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000, env: { ...process.env, ...env } }, (error, stdout) => {
                    const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
                    done({ code, stdout: String(stdout ?? "") });
                });
            }),
        launch: (file) =>
            new Promise((done) => {
                try {
                    const child = spawn(file, [], { detached: true, stdio: "ignore", shell: false, windowsHide: false, cwd: join(file, "..") });
                    child.once("error", () => done(false));
                    child.once("spawn", () => {
                        child.unref();
                        done(true);
                    });
                } catch {
                    done(false);
                }
            }),
        readText: readCapped,
        async writeText(path, text) {
            await mkdir(join(path, ".."), { recursive: true });
            const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
            await writeFile(temp, text, "utf8");
            await rename(temp, path);
        },
        exists: (path) => access(path).then(() => true, () => false),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms))
    };
}

/** The runner for a plugin on this machine, or null when it has no official software here. */
export function officialRunnerFor(id: string, pluginsDir: string, platform: NodeJS.Platform = process.platform, host: OfficialHost = nodeOfficialHost()): OfficialRunner | null {
    if (platform !== "win32" || !(OFFICIAL_PLUGINS as readonly string[]).includes(id)) return null;
    const env = process.env;
    const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
    return createOfficialRunner(host, {
        systemRoot,
        programFilesX86: env["ProgramFiles(x86)"] ?? env.ProgramFiles ?? "C:\\Program Files (x86)",
        appData: env.APPDATA ?? join(env.USERPROFILE ?? "", "AppData", "Roaming"),
        dataDir: join(pluginsDir, "official", id)
    });
}

/**
 * What lets Polaris open the Stream 100 on this machine: its own WinUSB driver
 * on Windows, the udev rule on Linux. Null on macOS (nothing is needed there)
 * and for another plugin.
 */
export function driverRunnerFor(id: string, pluginsDir: string, platform: NodeJS.Platform = process.platform, host: OfficialHost = nodeOfficialHost()): DriverRunner | null {
    if (id !== "hercules-stream100") return null;
    if (platform === "linux") return createUdevRunner(host);
    if (platform !== "win32") return null;
    const env = process.env;
    return createDriverRunner(host, { systemRoot: env.SystemRoot ?? env.WINDIR ?? "C:\\Windows", programData: env.ProgramData ?? "C:\\ProgramData", dataDir: join(pluginsDir, "official", id) }, platform);
}

/** The Stream 100's setting for Polaris' own driver ("Polaris driver on this PC"). */
export const DRIVER_SETTING = "polarisDriver";

/** Whether the driver setting reads on: Polaris' driver holds the device, or was set up and the device is unplugged. */
export function driverSettingOf(state: DriverState): boolean {
    return state.state === "installed" || (state.state === "unplugged" && state.installed);
}

/**
 * Every setting change from the page or the view goes through `set`. For the
 * Stream 100's driver setting, on runs the driver setup and off its removal
 * (each one Windows permission prompt), and the new value is kept only when
 * that went through; otherwise the stored value is written back as it was, so
 * every page holding the setting hears that it did not change, and the reason
 * is kept for `look` (the view's `driver.look`) to show. `look` also brings the
 * setting in line with the machine, as a Hercules reinstall or Windows Update
 * can take the device back without Polaris doing anything.
 */
export function createDriverSetting(manager: Pick<PluginManager, "settings" | "setSetting">, driverFor: (id: string) => DriverRunner | null) {
    const failures = new Map<string, DriverFailure>();
    const busy = new Set<string>();
    return {
        async set(id: string, key: unknown, value: unknown): Promise<Record<string, PluginSettingValue> | null> {
            const driver = key === DRIVER_SETTING && typeof value === "boolean" ? driverFor(id) : null;
            if (!driver) return manager.setSetting(id, key, value);
            // One prompt at a time: a second change while one is open keeps what is stored.
            if (busy.has(id)) return manager.settings(id);
            busy.add(id);
            try {
                const outcome: DriverOutcome = value ? await driver.install() : (await driver.installed()) ? await driver.remove() : { ok: true };
                if (outcome.ok) {
                    failures.delete(id);
                    return await manager.setSetting(id, key, value);
                }
                failures.set(id, outcome.reason);
                const values = await manager.settings(id);
                return values ? await manager.setSetting(id, key, values[DRIVER_SETTING] ?? !value) : null;
            } finally {
                busy.delete(id);
            }
        },
        async look(id: string): Promise<(DriverState & { readonly failure: DriverFailure | null }) | null> {
            const driver = driverFor(id);
            if (!driver) return null;
            const state = await driver.state();
            if (!busy.has(id)) {
                const values = await manager.settings(id);
                const on = driverSettingOf(state);
                if (values && DRIVER_SETTING in values && values[DRIVER_SETTING] !== on) await manager.setSetting(id, DRIVER_SETTING, on);
            }
            return { ...state, failure: failures.get(id) ?? null };
        }
    };
}

export type DriverSetting = ReturnType<typeof createDriverSetting>;

/**
 * One request from the page. `choose` carries the choice out first and
 * installs only when every step went through; the settings read from the
 * official app are then put on the plugin, and the pages it had are kept
 * beside them (`layout.json`) for the plugin to take as it learns each one.
 */
export async function answerOfficial(runner: OfficialRunner, manager: Pick<PluginManager, "install" | "setSetting">, id: string, request: OfficialRequest, write: (name: string, text: string) => Promise<void>): Promise<unknown> {
    switch (request.kind) {
        case "look": {
            const [{ found, imported }, backup] = await Promise.all([runner.look(), runner.readBackup()]);
            return {
                found,
                imported: imported ? { pages: imported.pages, controls: imported.controls } : null,
                backup: backup ? { choice: backup.choice, at: backup.at, restored: backup.restored } : null
            };
        }
        case "choose": {
            const done = await runner.execute(request.choice);
            if (!done.ok) return done;
            const installed = await manager.install(id, request.accepted);
            if (!installed.ok) return { ok: false, reason: "install", install: installed.reason };
            for (const [key, value] of Object.entries(done.values)) await manager.setSetting(id, key, value);
            if (done.layout) await write("layout.json", JSON.stringify(done.layout));
            return { ok: true };
        }
        case "restore":
            return runner.restore();
        case "launch":
            return runner.launch();
    }
}
