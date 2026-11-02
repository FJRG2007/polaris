/**
 * Installing Polaris TV on a set on this network, from a window, with no terminal.
 *
 * The rules come from the launcher's own PROMPT.md and are not this file's to
 * relax: a backup before the first change, nothing uninstalled or disabled, the
 * set's own launcher left enabled so Home always has a way back, Home confirmed
 * rather than assumed, and network ADB closed afterwards with only a refused
 * connection counting as closed.
 *
 * Debloating stays with the tools in `tv/`: it needs a person's choices per set.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { connect as tcp } from "node:net";
import { networkInterfaces } from "node:os";
import { openLocalWindow } from "./windows";
import { repository } from "../../package.json";
import { app, BrowserWindow, ipcMain } from "electron";
import { AdbConnection, newAdbKey } from "./adb-client";
import { parseChecksums, releaseSource } from "./releases";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CHANNELS, type TvInstallState, type TvOutcome } from "@/shared/bridge";

const PACKAGE = "app.polaris.tv";
const HOME_ACTIVITY = `${PACKAGE}/.MainActivity`;
const ADB_PORT = 5555;
const TAG_PREFIX = "tv-v";
const APK_NAME = "polaris-tv.apk";
const REMOTE_APK = "/data/local/tmp/polaris-tv.apk";
const MIN_SDK = 26;
const SCAN_MS = 700;
const SCAN_WIDTH = 48;
const CLOSE_ATTEMPTS = 6;
const CLOSE_WAIT_MS = 1_500;

/** A private IPv4 address: the only kind this will talk ADB to. */
export function readTvAddress(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const typed = value.trim();
    const parts = typed.split(".");
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
    const [a, b] = parts.map(Number) as [number, number];
    const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    return isPrivate ? parts.map(Number).join(".") : null;
}

/** What a failed connection means, in terms the person can act on. */
export function connectFailure(error: { code?: string; message?: string; }): TvOutcome {
    if (error.code === "ECONNREFUSED") return "adb-off";
    if (error.message === "The TV stopped answering.") return "not-allowed";
    if (error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH") return "unreachable";
    return "unreachable";
}

/** Whether the shell's answer is an Android TV this launcher can run on. */
export function tvRefusal(sdk: string, leanback: string): TvOutcome | null {
    if (!/feature:android\.software\.leanback/.test(leanback)) return "not-android-tv";
    const level = Number.parseInt(sdk.trim(), 10);
    return Number.isNaN(level) || level < MIN_SDK ? "too-old" : null;
}

export function homeIsOurs(resolved: string): boolean {
    return resolved.split(/\s+/).some((line) => line === HOME_ACTIVITY || line === `${PACKAGE}/${PACKAGE}.MainActivity`);
}

/** The addresses to try on the networks this computer is on. */
function neighbours(): string[] {
    const found = new Set<string>();
    for (const list of Object.values(networkInterfaces())) {
        for (const entry of list ?? []) {
            if (entry.family !== "IPv4" || entry.internal || !readTvAddress(entry.address)) continue;
            const base = entry.address.split(".").slice(0, 3).join(".");
            for (let last = 1; last < 255; last += 1) found.add(`${base}.${last}`);
            found.delete(entry.address);
        }
    }
    return [...found];
}

function answersOn(host: string, port: number, timeoutMs: number): Promise<"open" | "refused" | "silent"> {
    return new Promise((resolve) => {
        const socket = tcp({ host, port });
        const done = (verdict: "open" | "refused" | "silent") => {
            socket.destroy();
            resolve(verdict);
        };
        socket.setTimeout(timeoutMs, () => done("silent"));
        socket.once("connect", () => done("open"));
        socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "refused" : "silent"));
    });
}

async function findTvs(): Promise<string[]> {
    const queue = neighbours();
    const open: string[] = [];
    await Promise.all(
        Array.from({ length: SCAN_WIDTH }, async () => {
            for (let host = queue.pop(); host; host = queue.pop()) {
                if ((await answersOn(host, ADB_PORT, SCAN_MS)) === "open") open.push(host);
            }
        })
    );
    return open.sort();
}

async function adbKey(): Promise<string> {
    const path = join(app.getPath("userData"), "tv-adb-key.pem");
    const held = await readFile(path, "utf8").catch(() => null);
    if (held) return held;
    const key = newAdbKey();
    await writeFile(path, key, { mode: 0o600 });
    return key;
}

interface Asset {
    readonly name: string;
    readonly url: string;
}

/** The newest published APK and its checksum, or null when none has been released. */
async function latestApk(): Promise<{ apk: Buffer; version: string; } | null> {
    const source = releaseSource(repository);
    if (!source) return null;
    const response = await fetch(source.api, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error("download");
    const releases = (await response.json()) as readonly {
        tag_name?: string;
        draft?: boolean;
        prerelease?: boolean;
        assets?: readonly { name?: string; browser_download_url?: string; }[];
    }[];
    const release = releases.find(
        (one) => one.tag_name?.startsWith(TAG_PREFIX) && !one.draft && !one.prerelease
    );
    if (!release?.tag_name) return null;
    const assets: Asset[] = (release.assets ?? []).flatMap((one) =>
        one.name && one.browser_download_url ? [{ name: one.name, url: one.browser_download_url }] : []
    );
    const apkAsset = assets.find((one) => one.name === APK_NAME);
    const sums = assets.find((one) => one.name === "SHA256SUMS");
    if (!apkAsset || !sums) return null;
    const expected = parseChecksums(await (await fetch(sums.url)).text()).get(APK_NAME);
    const download = await fetch(apkAsset.url);
    if (!download.ok || !expected) throw new Error("download");
    const apk = Buffer.from(await download.arrayBuffer());
    if (createHash("sha256").update(apk).digest("hex") !== expected) throw new Error("download");
    return { apk, version: release.tag_name.slice(TAG_PREFIX.length) };
}

async function backUp(adb: AdbConnection, host: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const folder = join(app.getPath("userData"), "tv-backups", `${host}-${stamp}`);
    await mkdir(folder, { recursive: true });
    const reads: readonly (readonly [string, string])[] = [
        ["packages.txt", "pm list packages"],
        ["disabled.txt", "pm list packages -d"],
        ["getprop.txt", "getprop"],
        ["settings-global.txt", "settings list global"],
        ["settings-secure.txt", "settings list secure"],
        ["settings-system.txt", "settings list system"]
    ];
    for (const [name, command] of reads) await writeFile(join(folder, name), await adb.shell(command));
    return folder;
}

let window: BrowserWindow | null = null;
let busy = false;
let state: TvInstallState = { phase: "ready", found: [], outcome: null, backup: null, closed: null };

function publish(next: Partial<TvInstallState>): void {
    state = { ...state, ...next };
    window?.webContents.send(CHANNELS.tvEvent, state);
}

async function closeAdb(adb: AdbConnection, host: string): Promise<boolean> {
    await adb.shell("settings put global adb_wifi_enabled 0; settings put global adb_enabled 0").catch(() => "");
    adb.close();
    for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
        if ((await answersOn(host, ADB_PORT, SCAN_MS)) === "refused") return true;
        await new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS));
    }
    return false;
}

async function install(host: string, makeHome: boolean): Promise<void> {
    publish({ phase: "connecting", outcome: null, backup: null, closed: null });
    const adb = new AdbConnection({
        host,
        port: ADB_PORT,
        key: await adbKey(),
        connectMs: 8_000,
        approveMs: 60_000,
        commandMs: 60_000,
        onPrompt: () => publish({ phase: "allow" })
    });
    try {
        await adb.open();
    } catch (caught) {
        adb.close();
        publish({ phase: "failed", outcome: connectFailure(caught as NodeJS.ErrnoException) });
        return;
    }
    try {
        publish({ phase: "checking" });
        const refusal = tvRefusal(await adb.shell("getprop ro.build.version.sdk"), await adb.shell("pm list features"));
        if (refusal) {
            adb.close();
            publish({ phase: "failed", outcome: refusal });
            return;
        }
        publish({ phase: "backup" });
        publish({ backup: await backUp(adb, host) });

        publish({ phase: "download" });
        const release = await latestApk().catch(() => undefined);
        if (release === undefined || release === null) {
            await finish(adb, host, release === null ? "not-released" : "download-failed");
            return;
        }

        publish({ phase: "install" });
        await adb.push(REMOTE_APK, release.apk);
        const installed = await adb.shell(`pm install -r ${REMOTE_APK}`, 180_000);
        await adb.shell(`rm -f ${REMOTE_APK}`);
        if (!installed.includes("Success")) {
            await finish(adb, host, /VERIFICATION_FAILURE/.test(installed) ? "sideload-refused" : "install-failed");
            return;
        }
        await adb.shell(`pm grant ${PACKAGE} android.permission.ACCESS_FINE_LOCATION`).catch(() => "");

        let outcome: TvOutcome = "installed";
        if (makeHome) {
            publish({ phase: "home" });
            await adb.shell(`cmd package set-home-activity --user 0 ${HOME_ACTIVITY}`);
            const resolved = await adb.shell(
                "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME"
            );
            outcome = homeIsOurs(resolved) ? "installed-home" : "installed-home-refused";
        }
        await finish(adb, host, outcome);
    } catch (caught) {
        console.error("[tv]", caught);
        await finish(adb, host, "install-failed");
    }
}

async function finish(adb: AdbConnection, host: string, outcome: TvOutcome): Promise<void> {
    publish({ phase: "closing" });
    const closed = await closeAdb(adb, host);
    publish({ phase: outcome.startsWith("installed") ? "done" : "failed", outcome, closed });
}

/** The window. One at a time: a second click brings it forward. */
export function openTvInstall(): void {
    if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        return;
    }
    window = openLocalWindow("tv", { title: "Install on a TV - Polaris", width: 560, height: 620 });
    window.on("closed", () => {
        window = null;
    });
}

export function registerTvInstall(): void {
    ipcMain.handle(CHANNELS.tvState, () => state);
    ipcMain.handle(CHANNELS.tvFind, async () => {
        if (busy) return state;
        busy = true;
        publish({ phase: "searching" });
        const found = await findTvs().catch(() => []);
        busy = false;
        publish({ phase: "ready", found });
        return state;
    });
    ipcMain.handle(CHANNELS.tvStart, async (_event, raw: unknown) => {
        const input = (raw ?? {}) as { host?: unknown; home?: unknown; };
        const host = readTvAddress(input.host);
        if (!host || busy) return false;
        busy = true;
        void install(host, input.home === true).finally(() => {
            busy = false;
        });
        return true;
    });
}
