/**
 * Installing Polaris TV on a set on this network, from a window, with no terminal.
 *
 * What this keeps from the launcher's own PROMPT.md: a backup before the first
 * change, nothing uninstalled or disabled, the set's own launcher left enabled so
 * Home always has a way back, Home confirmed rather than assumed, and network and
 * USB debugging switched off afterwards with only a refused connection on port
 * 5555 counting as closed.
 *
 * What it does not: PROMPT.md's closing also revokes USB debugging authorisations,
 * checks the Wireless debugging port, reboots the set and checks again. Nobody
 * asked this window to restart their TV, so those stay with the tools in `tv/`,
 * as does debloating, which needs a person's choices per set.
 */

import { z } from "zod";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { connect as tcp } from "node:net";
import { networkInterfaces } from "node:os";
import { openLocalWindow } from "./windows";
import { repository } from "../../package.json";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { AdbConnection, newAdbKey } from "./adb-client";
import { CHECKSUMS, parseChecksums, releaseSource } from "./releases";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readTvAddress } from "@/shared/tv-address";
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
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const LOOKUP_MS = 15_000;
const DOWNLOAD_MS = 300_000;

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

/** Bumped by a cancel, so a search started before it stops taking addresses. */
let search = 0;

async function findTvs(run: number): Promise<string[]> {
    const queue = neighbours();
    const open: string[] = [];
    await Promise.all(
        Array.from({ length: SCAN_WIDTH }, async () => {
            for (let host = queue.pop(); host && run === search; host = queue.pop()) {
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

const releasesSchema = z.array(
    z.object({
        tag_name: z.string(),
        draft: z.boolean(),
        prerelease: z.boolean(),
        assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })).default([])
    })
);

type PublishedRelease = z.infer<typeof releasesSchema>[number];

/** The newest TV release. One list holds every kind of release, so it can be
 *  pages back from the first. */
async function newestRelease(api: string): Promise<PublishedRelease | null> {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await fetch(`${api}&page=${page}`, {
            headers: { accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(LOOKUP_MS)
        });
        if (!response.ok) throw new Error("download");
        const releases = releasesSchema.parse(await response.json());
        const release = releases.find((one) => one.tag_name.startsWith(TAG_PREFIX) && !one.draft && !one.prerelease);
        if (release) return release;
        if (releases.length < PAGE_SIZE) return null;
    }
    return null;
}

/** The newest published APK, verified, or null when none has been released. */
export async function latestApk(): Promise<{ apk: Buffer; version: string; } | null> {
    const source = releaseSource(repository);
    if (!source) return null;
    const release = await newestRelease(source.api);
    if (!release) return null;
    const apkAsset = release.assets.find((one) => one.name === APK_NAME);
    const sums = release.assets.find((one) => one.name === CHECKSUMS);
    if (!apkAsset || !sums) return null;
    const listed = await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(LOOKUP_MS) });
    const expected = parseChecksums(await listed.text()).get(APK_NAME);
    const download = await fetch(apkAsset.browser_download_url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!listed.ok || !download.ok || !expected) throw new Error("download");
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
/** The pages that asked for the state - the TV window, a dashboard's dialog - and so hear every change. */
const pages = new Set<WebContents>();
let busy = false;
let state: TvInstallState = { phase: "ready", found: [], outcome: null, backup: null, closed: null };

function publish(next: Partial<TvInstallState>): void {
    state = { ...state, ...next };
    for (const page of pages) if (!page.isDestroyed()) page.send(CHANNELS.tvEvent, state);
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

/** How far an install got, which decides what a failure can truthfully say. */
export type TvStage = "check" | "backup" | "send" | "install" | "home";

/** What an error part way through means for the set. */
export function lateFailure(stage: TvStage): TvOutcome {
    if (stage === "backup") return "backup-failed";
    if (stage === "install") return "install-interrupted";
    return stage === "home" ? "installed-home-unknown" : "connection-lost";
}

async function install(host: string, makeHome: boolean): Promise<void> {
    publish({ phase: "download", outcome: null, backup: null, closed: null });
    const release = await latestApk().catch((caught: unknown) => {
        console.error("[tv]", caught);
        return undefined;
    });
    if (!release) {
        publish({ phase: "failed", outcome: release === null ? "not-released" : "download-failed" });
        return;
    }
    const key = await adbKey().catch((caught: unknown) => {
        console.error("[tv]", caught);
        return null;
    });
    if (!key) {
        publish({ phase: "failed", outcome: "key-failed" });
        return;
    }

    publish({ phase: "connecting" });
    const adb = new AdbConnection({
        host,
        port: ADB_PORT,
        key,
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

    let stage: TvStage = "check";
    try {
        publish({ phase: "checking" });
        const refusal = tvRefusal(await adb.shell("getprop ro.build.version.sdk"), await adb.shell("pm list features"));
        if (refusal) {
            await finish(adb, host, refusal);
            return;
        }
        stage = "backup";
        publish({ phase: "backup" });
        publish({ backup: await backUp(adb, host) });

        stage = "send";
        publish({ phase: "install" });
        await adb.push(REMOTE_APK, release.apk);
        stage = "install";
        const installed = await adb.shell(`pm install -r ${REMOTE_APK}`, 180_000);
        await adb.shell(`rm -f ${REMOTE_APK}`).catch(() => "");
        if (!installed.includes("Success")) {
            await finish(adb, host, /VERIFICATION_FAILURE/.test(installed) ? "sideload-refused" : "install-failed");
            return;
        }
        stage = "home";
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
        await finish(adb, host, lateFailure(stage));
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

const startSchema = z.object({
    host: z.unknown().transform(readTvAddress).pipe(z.string()),
    home: z.boolean()
});

/** `fromTv` accepts the TV window and a Polaris window on its own Polaris. */
export function registerTvInstall(fromTv: (event: IpcMainInvokeEvent) => boolean): void {
    ipcMain.handle(CHANNELS.tvState, (event) => {
        if (!fromTv(event)) return null;
        const page = event.sender;
        if (!pages.has(page)) {
            pages.add(page);
            page.once("destroyed", () => pages.delete(page));
        }
        return state;
    });
    ipcMain.handle(CHANNELS.tvCancel, (event) => {
        if (!fromTv(event)) return null;
        if (state.phase !== "searching") return state;
        search += 1;
        busy = false;
        publish({ phase: "ready" });
        return state;
    });
    ipcMain.handle(CHANNELS.tvFind, async (event) => {
        if (!fromTv(event)) return null;
        if (busy) return state;
        busy = true;
        search += 1;
        const run = search;
        publish({ phase: "searching", found: [] });
        const found = await findTvs(run).catch(() => []);
        // A cancelled search has already handed the controls back.
        if (run !== search) return state;
        busy = false;
        publish({ phase: "ready", found });
        return state;
    });
    ipcMain.handle(CHANNELS.tvStart, async (event, raw: unknown) => {
        const input = startSchema.safeParse(raw);
        if (!fromTv(event) || !input.success || busy) return false;
        busy = true;
        void install(input.data.host, input.data.home).finally(() => {
            busy = false;
        });
        return true;
    });
}
