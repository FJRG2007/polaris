/**
 * The official software of the devices plugins drive, as the install dialog
 * and a plugin's page reach it (`window.polarisDesktop.plugins.official`).
 * Only Hercules' Stream Control is known today, on Windows only; every other
 * plugin and platform is answered null and nothing runs.
 */

import { z } from "zod";
import { join } from "node:path";
import type { PluginManager } from "./manager";
import { spawn, execFile } from "node:child_process";
import { access, mkdir, open, rename, writeFile } from "node:fs/promises";
import { PLUGIN_PERMISSIONS } from "@polaris/core/device-plugins";
import { createOfficialRunner, type OfficialHost, type OfficialRunner } from "./hercules-official-run";
import type { RequirementRunner } from "./requirements";
import { createDriverRunner, type DriverFailure, type DriverRunner, type DriverState } from "./hercules-driver";

/** The plugins whose device ships official software Polaris knows how to find. */
export const OFFICIAL_PLUGINS = ["hercules-stream100"] as const;

export const officialRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("look") }),
    z.object({
        kind: z.literal("choose"),
        choice: z.enum(["stop", "uninstall", "keep"]),
        accepted: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length),
        /** What the consent listed to set up (the manifest's `requires` keys); absent from a page older than it. */
        requires: z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/)).max(8).default([])
    }),
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

/** The Stream 100's own WinUSB driver on this machine, or null off Windows or for another plugin. */
export function driverRunnerFor(id: string, pluginsDir: string, platform: NodeJS.Platform = process.platform, host: OfficialHost = nodeOfficialHost()): DriverRunner | null {
    if (platform !== "win32" || id !== "hercules-stream100") return null;
    const env = process.env;
    return createDriverRunner(host, { systemRoot: env.SystemRoot ?? env.WINDIR ?? "C:\\Windows", programData: env.ProgramData ?? "C:\\ProgramData", dataDir: join(pluginsDir, "official", id) }, platform);
}

/** The key the Stream 100's manifest lists its driver under (`requires`, Windows only). */
export const DRIVER_REQUIREMENT = "driver";

/** Polaris' driver as a requirement: met while it (or WinUSB) holds the device, missing while another driver does. */
export function driverRequirement(driver: DriverRunner): RequirementRunner {
    return {
        async look() {
            const state = await driver.state();
            switch (state.state) {
                case "notNeeded":
                case "installed":
                    return { state: "met", before: state.state === "installed" };
                case "needed":
                    return { state: "missing", before: false };
                case "repair":
                    return { state: "missing", before: true };
                case "unplugged":
                    return { state: "away", before: state.installed };
            }
        },
        setUp: () => driver.install()
    };
}

/** What can set a plugin's requirement up on this machine; only the Stream 100's driver is known. */
export function requirementRunnerFor(id: string, key: string, pluginsDir: string): RequirementRunner | null {
    const driver = key === DRIVER_REQUIREMENT ? driverRunnerFor(id, pluginsDir) : null;
    return driver ? driverRequirement(driver) : null;
}

/** The Stream 100 view's `driver.look`: where the driver stands and why its last setup did not go through. */
export async function lookDriver(driver: DriverRunner | null, failure: string | null): Promise<(DriverState & { readonly failure: DriverFailure | null }) | null> {
    if (!driver) return null;
    return { ...(await driver.state()), failure: (failure as DriverFailure | null) ?? null };
}

/**
 * One request from the page. `choose` carries the choice out first and
 * installs only when every step went through; the settings read from the
 * official app are then put on the plugin, and the pages it had are kept
 * beside them (`layout.json`) for the plugin to take as it learns each one.
 */
export async function answerOfficial(runner: OfficialRunner, manager: Pick<PluginManager, "install" | "setSetting">, id: string, request: OfficialRequest, write: (name: string, text: string) => Promise<void>, installed: (requires: readonly string[]) => Promise<void> = async () => undefined): Promise<unknown> {
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
            const install = await manager.install(id, request.accepted);
            if (!install.ok) return { ok: false, reason: "install", install: install.reason };
            for (const [key, value] of Object.entries(done.values)) await manager.setSetting(id, key, value);
            if (done.layout) await write("layout.json", JSON.stringify(done.layout));
            await installed(request.requires);
            return { ok: true };
        }
        case "restore":
            return runner.restore();
        case "launch":
            return runner.launch();
    }
}
