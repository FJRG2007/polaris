/**
 * The official software of the devices add-ons drive, as the install dialog
 * and an add-on's page reach it (`window.polarisDesktop.addons.official`).
 * Only Hercules' Stream Control is known today, on Windows only; every other
 * add-on and platform is answered null and nothing runs.
 */

import { z } from "zod";
import { join } from "node:path";
import type { AddonManager } from "./manager";
import { spawn, execFile } from "node:child_process";
import { ADDON_PERMISSIONS } from "@polaris/core/device-addons";
import { access, mkdir, open, rename, writeFile } from "node:fs/promises";
import { createOfficialRunner, type OfficialHost, type OfficialRunner } from "./hercules-official-run";

/** The add-ons whose device ships official software Polaris knows how to find. */
export const OFFICIAL_ADDONS = ["hercules-stream100"] as const;

export const officialRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("look") }),
    z.object({ kind: z.literal("choose"), choice: z.enum(["stop", "uninstall", "keep"]), accepted: z.array(z.enum(ADDON_PERMISSIONS)).max(ADDON_PERMISSIONS.length) }),
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

/** The runner for an add-on on this machine, or null when it has no official software here. */
export function officialRunnerFor(id: string, addonsDir: string, platform: NodeJS.Platform = process.platform, host: OfficialHost = nodeOfficialHost()): OfficialRunner | null {
    if (platform !== "win32" || !(OFFICIAL_ADDONS as readonly string[]).includes(id)) return null;
    const env = process.env;
    const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
    return createOfficialRunner(host, {
        systemRoot,
        programFilesX86: env["ProgramFiles(x86)"] ?? env.ProgramFiles ?? "C:\\Program Files (x86)",
        appData: env.APPDATA ?? join(env.USERPROFILE ?? "", "AppData", "Roaming"),
        dataDir: join(addonsDir, "official", id)
    });
}

/**
 * One request from the page. `choose` carries the choice out first and
 * installs only when every step went through; the settings read from the
 * official app are then put on the add-on, and the pages it had are kept
 * beside them (`layout.json`) for the add-on to take as it learns each one.
 */
export async function answerOfficial(runner: OfficialRunner, manager: Pick<AddonManager, "install" | "setSetting">, id: string, request: OfficialRequest, write: (name: string, text: string) => Promise<void>): Promise<unknown> {
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
