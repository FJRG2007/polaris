/**
 * Installing Polaris TV on a set on this network, from a window, with no terminal.
 *
 * What this keeps from the launcher's own PROMPT.md: a backup before the first
 * change, nothing uninstalled or disabled, the set's own launcher left enabled so
 * Home always has a way back, Home confirmed rather than assumed, and network and
 * USB debugging switched off afterwards with only a refused connection on port
 * 5555 counting as closed - or, over a USB cable, the TV no longer offering ADB.
 *
 * Over the network or over a USB cable: the TV's own Wireless debugging can be
 * one a set switches straight back off, and a cable needs none of it.
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
import { serverAddress } from "./settings";
import { openLocalWindow } from "./windows";
import { repository } from "../../package.json";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { usbDevices, usbLink } from "./usb-link";
import { AdbConnection, androidPublicKey, newAdbKey } from "./adb-client";
import { adbCertificate, PairingError, pairTv, readPairingCode } from "./adb-pairing";
import { waitForTv, type TvWaitResult, type TvWaitStep } from "./tv-wait";
import { choosePath, HOME_GUARD_PACKAGE, listsPackage, type TvEdition, type TvPath } from "./tv-path";
import { browseTvs, mergeFound, namesOf, sightingOf, type TvAnnouncement } from "./tv-mdns";
import { CHECKSUMS, parseChecksums, releaseSource } from "./releases";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readTvAddress } from "@/shared/tv-address";
import { CHANNELS, type TvControl, type TvControlRung, type TvInstallMode, type TvInstallState, type TvOutcome, type TvWaiting } from "@/shared/bridge";

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
/** How often the port is tried while the person turns debugging on, and for how long in all. */
const WAIT_EVERY_MS = 2_000;
const WAIT_FOR_MS = 600_000;
/** How long a search listens for TVs announcing themselves, and how long an install does when the address was typed. */
const BROWSE_MS = 3_000;
const INSTALL_BROWSE_MS = 1_500;

/** What a failed connection means, in terms the person can act on. */
export function connectFailure(error: { code?: string; message?: string; }): TvOutcome {
    if (error.code === "USB_BUSY") return "usb-busy";
    if (error.code === "USB_GONE") return "usb-gone";
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
/** Bumped by a cancel and when a wait ends, so a wait for the TV stops polling. */
let waitRun = 0;
/** What TVs announced in the last search, by address. */
let announced = new Map<string, TvAnnouncement>();
/** The connection waiting on the TV's prompt, closed by a cancel so the wait ends now rather than at the prompt's timeout. */
let pending: AdbConnection | null = null;
/** Ends a Wireless debugging pairing in progress. */
let pairing: AbortController | null = null;

/** The one instruction for this TV while the install waits on it. */
export function waitingFor(step: TvWaitStep, path: TvPath): TvWaiting {
    const { id, about, press, presses, developer, switches } = path.instruction;
    return { step, steps: id, about, press, presses, developer, switches };
}

/** What a wait that ended without a connection tells the person. */
export function waitOutcome(waited: Exclude<TvWaitResult<unknown>, { kind: "connected" | "cancelled" }>): TvOutcome {
    if (waited.kind === "failed") return waited.outcome as TvOutcome;
    return waited.step === "prompt" ? "not-allowed" : "adb-off";
}

async function findTvs(run: number): Promise<{ found: string[]; heard: Map<string, TvAnnouncement>; }> {
    const queue = neighbours();
    const open: string[] = [];
    const sweep = Promise.all(
        Array.from({ length: SCAN_WIDTH }, async () => {
            for (let host = queue.pop(); host && run === search; host = queue.pop()) {
                if ((await answersOn(host, ADB_PORT, SCAN_MS)) === "open") open.push(host);
            }
        })
    );
    const [heard] = await Promise.all([browseTvs(BROWSE_MS, () => run !== search).catch(() => new Map<string, TvAnnouncement>()), sweep]);
    return { found: mergeFound(open, heard), heard };
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

/** The release asset an edition is published as (`.github/workflows/tv.yml`). */
export function apkNameOf(edition: TvEdition): string {
    return edition === "standard" ? APK_NAME : `polaris-tv-${edition}.apk`;
}

/** The newest TV release, or null when none is published or it has no ordinary APK to install. */
async function latestTvRelease(): Promise<PublishedRelease | null> {
    const source = releaseSource(repository);
    if (!source) return null;
    const release = await newestRelease(source.api);
    return release?.assets.some((one) => one.name === APK_NAME) ? release : null;
}

/** An edition's APK from a release, verified, or null when the release does not publish it. */
async function apkOf(release: PublishedRelease, edition: TvEdition): Promise<{ apk: Buffer; version: string; } | null> {
    const name = apkNameOf(edition);
    const apkAsset = release.assets.find((one) => one.name === name);
    const sums = release.assets.find((one) => one.name === CHECKSUMS);
    if (!apkAsset || !sums) return null;
    const listed = await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(LOOKUP_MS) });
    const expected = parseChecksums(await listed.text()).get(name);
    const download = await fetch(apkAsset.browser_download_url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!listed.ok || !download.ok || !expected) throw new Error("download");
    const apk = Buffer.from(await download.arrayBuffer());
    if (createHash("sha256").update(apk).digest("hex") !== expected) throw new Error("download");
    return { apk, version: release.tag_name.slice(TAG_PREFIX.length) };
}

/** The newest published APK of an edition, verified, or null when the newest release has none. */
export async function latestApk(edition: TvEdition = "standard"): Promise<{ apk: Buffer; version: string; } | null> {
    const source = releaseSource(repository);
    if (!source) return null;
    const release = await newestRelease(source.api);
    return release ? apkOf(release, edition) : null;
}

/** A TV on the network by its address, or one plugged in by USB by its id. */
export type TvTarget = { readonly kind: "network"; readonly host: string; } | { readonly kind: "usb"; readonly id: string; };

/** The backup folder's name for a TV: its address, or its USB id with only safe characters. */
export function targetLabel(target: TvTarget): string {
    return target.kind === "network" ? target.host : `usb-${target.id.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64)}`;
}

/** The TV's Private DNS before anything changed, named, so a missing key reads as "null" rather than a blank line. */
export const PRIVATE_DNS_READ =
    "echo private_dns_mode=$(settings get global private_dns_mode); echo private_dns_specifier=$(settings get global private_dns_specifier)";

/**
 * Opens the TV's link screen with this app's Polaris filled in, one press on the remote from the code to scan.
 * Null when there is no Polaris yet, when its address is this computer's own loopback (the TV would ask itself),
 * or when it is not a plain http(s) origin: the value goes into a shell command line, so nothing else is let through.
 */
export function linkCommand(server: string | null): string | null {
    if (!server) return null;
    let origin: string;
    try {
        origin = new URL(server).origin;
    } catch {
        return null;
    }
    if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin)) return null;
    if (loopback(new URL(origin).hostname)) return null;
    return `am start -n ${PACKAGE}/.LinkFromInstall --es origin ${origin}`;
}

function loopback(host: string): boolean {
    const name = host.toLowerCase().replace(/\.$/, "");
    return name === "localhost" || name.endsWith(".localhost") || /^127\./.test(name) || name === "0.0.0.0"
        || name === "[::1]" || name === "[::]" || name.startsWith("[::ffff:7f");
}

/** Asks the installed launcher whether this TV is already linked; stopped packages included, as a fresh install is. */
export const LINK_STATE_READ = `am broadcast -f 32 -n ${PACKAGE}/.LinkState`;

/** Whether the launcher answered that it is linked; anything else, an error included, reads as not linked. */
export function alreadyLinked(output: string): boolean {
    return /data="linked=true"/.test(output);
}

/** Whether `am start` reported the activity started rather than an error. */
export function opened(output: string): boolean {
    return output.trim().length > 0 && !/Error|Exception/i.test(output);
}

/**
 * The runtime grants after the install. Location names the Wi-Fi in the launcher's network row;
 * WRITE_SECURE_SETTINGS, only when asked, lets "Block ads and trackers" set Private DNS and put the
 * TV's own back when it does not work. Neither is ever revoked here: the launcher's own scripts may
 * have granted the second for another switch.
 */
export function grantCommands(blockAds: boolean): readonly string[] {
    const grants = [`pm grant ${PACKAGE} android.permission.ACCESS_FINE_LOCATION`];
    if (blockAds) grants.push(`pm grant ${PACKAGE} android.permission.WRITE_SECURE_SETTINGS`);
    return grants;
}

const HOME_KEY_SERVICE = `${PACKAGE}/.HomeKeyService`;
const ACCESSIBILITY_LIST = "enabled_accessibility_services";

/** Reads the accessibility list. */
export const ACCESSIBILITY_READ = `settings get secure ${ACCESSIBILITY_LIST}`;

/** Reads the list and the switch back, one per line. */
export const HOME_KEY_READ = `${ACCESSIBILITY_READ}; settings get secure accessibility_enabled`;

const COMPONENT = /^[\w.$]+\/[\w.$]+$/;

function isHomeKey(entry: string): boolean {
    return entry === HOME_KEY_SERVICE || entry === `${PACKAGE}/${PACKAGE}.HomeKeyService`;
}

/**
 * The services on ACCESSIBILITY_READ's answer: "null" and empty are none. Null when the answer is
 * not a list of components (an error from the TV), so nothing is written over what is really there.
 */
export function accessibilityEntries(read: string): string[] | null {
    const list = read.trim();
    if (list === "" || list === "null") return [];
    const entries = list.split(":").filter((entry) => entry !== "");
    return entries.every((entry) => COMPONENT.test(entry)) ? entries : null;
}

function settingValue(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The commands that put the launcher's HomeKeyService on the accessibility list after whatever is
 * there, never in place of it, and switch accessibility on. A service already listed was dropped
 * while its APK was replaced and binds again only once the list changes, so the list is cleared and
 * written back as it was (`tv/launcher/build-and-install.sh`, enable_service).
 */
export function homeKeyCommands(entries: readonly string[]): string[] {
    const put = (list: readonly string[]) => `settings put secure ${ACCESSIBILITY_LIST} ${settingValue(list.join(":"))}`;
    const on = "settings put secure accessibility_enabled 1";
    if (!entries.some(isHomeKey)) return [put([...entries, HOME_KEY_SERVICE]), on];
    return [`${put([])}; settings put secure accessibility_enabled 0; sleep 1; ${put(entries)}`, on];
}

/** Whether HOME_KEY_READ shows HomeKeyService listed, in either spelling, with accessibility on. */
export function homeKeyOn(read: string): boolean {
    const [list = "", enabled = ""] = read.trim().split(/\s*\n\s*/);
    return (accessibilityEntries(list) ?? []).some(isHomeKey) && enabled.trim() === "1";
}

/** What an install was asked to do: `mode` when the page sends it, else what `home` meant before it existed. */
export function installMode(input: { readonly mode?: TvInstallMode; readonly home?: boolean; }): TvInstallMode {
    return input.mode ?? (input.home === false ? "app" : "system");
}

/** The Home level, from how the Home step ended: skipped where the TV keeps its own Home. */
export function homeControl(offered: boolean, outcome: TvOutcome): TvControl {
    if (!offered) return { rung: "home", state: "skipped" };
    return { rung: "home", state: outcome === "installed-home" || outcome === "installed-home-key" ? "got" : "refused" };
}

const LISTENER_LIST = "enabled_notification_listeners";
const GUARD_REVIVAL = `${PACKAGE}/.GuardRevival`;

function isGuardRevival(entry: string): boolean {
    return entry === GUARD_REVIVAL || entry === `${PACKAGE}/${PACKAGE}.GuardRevival`;
}

/**
 * One level of control past Home. `before` is read first where the command has to keep what is
 * there; `commands` answers null when that read is not what it should be, so nothing is written.
 * `check` is read afterwards and `got` says whether it shows the level in place.
 */
export interface TvControlGrant {
    readonly rung: Exclude<TvControlRung, "home">;
    readonly before?: string;
    readonly commands: (before: string) => readonly string[] | null;
    readonly check: string;
    readonly got: (check: string) => boolean;
}

/**
 * The listener list with GuardRevival after whatever is there, never in place of it; nothing
 * when it is listed already, and null when the list is not a list of components.
 */
export function listenerCommands(read: string): string[] | null {
    const entries = accessibilityEntries(read);
    if (!entries) return null;
    if (entries.some(isGuardRevival)) return [];
    return [`settings put secure ${LISTENER_LIST} ${settingValue([...entries, GUARD_REVIVAL].join(":"))}`];
}

/** Whether `dumpsys package` lines show WRITE_SECURE_SETTINGS granted. */
export function secureSettingsGranted(check: string): boolean {
    return /android\.permission\.WRITE_SECURE_SETTINGS: granted=true/.test(check);
}

/** Whether `appops get` answers that installing apps is allowed. */
export function installPackagesAllowed(check: string): boolean {
    return /^\s*REQUEST_INSTALL_PACKAGES: allow\b/m.test(check);
}

/** Whether `dumpsys deviceidle whitelist` lists the launcher (lines like `user,app.polaris.tv,10123`). */
export function batteryWhitelisted(check: string): boolean {
    return check.split(/\r?\n/).some((line) => line.trim().split(",")[1] === PACKAGE);
}

/**
 * What the system mode asks for past Home, strongest first. Only what the launcher declares or
 * implements (tv/launcher/app/src/main/AndroidManifest.xml): it has no usage-stats or overlay
 * permission, so those app-ops are not asked for.
 */
export const CONTROL_GRANTS: readonly TvControlGrant[] = [
    {
        rung: "secure-settings",
        commands: () => [`pm grant ${PACKAGE} android.permission.WRITE_SECURE_SETTINGS`],
        check: `dumpsys package ${PACKAGE} | grep -F WRITE_SECURE_SETTINGS`,
        got: secureSettingsGranted
    },
    {
        // GuardRevival brings the launcher back after the firmware force-stops it; it reads no notification.
        rung: "notification-listener",
        before: `settings get secure ${LISTENER_LIST}`,
        commands: listenerCommands,
        check: `settings get secure ${LISTENER_LIST}`,
        got: (check) => (accessibilityEntries(check) ?? []).some(isGuardRevival)
    },
    {
        rung: "install-packages",
        commands: () => [`appops set ${PACKAGE} REQUEST_INSTALL_PACKAGES allow`],
        check: `appops get ${PACKAGE} REQUEST_INSTALL_PACKAGES`,
        got: installPackagesAllowed
    },
    {
        rung: "battery",
        commands: () => [`dumpsys deviceidle whitelist +${PACKAGE}`],
        check: "dumpsys deviceidle whitelist",
        got: batteryWhitelisted
    }
];

/** Runs each grant and reads it back; one the TV refuses, or that fails, is recorded and the next is tried. */
async function grantControl(adb: AdbConnection): Promise<TvControl[]> {
    const control: TvControl[] = [];
    for (const grant of CONTROL_GRANTS) {
        let got = false;
        try {
            const commands = grant.commands(grant.before ? await adb.shell(grant.before) : "");
            for (const command of commands ?? []) await adb.shell(command);
            got = grant.got(await adb.shell(grant.check));
        } catch (caught) {
            console.error("[tv] control", grant.rung, caught);
        }
        control.push({ rung: grant.rung, state: got ? "got" : "refused" });
    }
    return control;
}

async function backUp(adb: AdbConnection, target: TvTarget): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const folder = join(app.getPath("userData"), "tv-backups", `${targetLabel(target)}-${stamp}`);
    await mkdir(folder, { recursive: true });
    const reads: readonly (readonly [string, string])[] = [
        ["packages.txt", "pm list packages"],
        ["disabled.txt", "pm list packages -d"],
        ["getprop.txt", "getprop"],
        ["settings-global.txt", "settings list global"],
        ["settings-secure.txt", "settings list secure"],
        ["settings-system.txt", "settings list system"],
        ["private-dns.txt", PRIVATE_DNS_READ]
    ];
    for (const [name, command] of reads) await writeFile(join(folder, name), await adb.shell(command));
    return folder;
}

let window: BrowserWindow | null = null;
/** The pages that asked for the state - the TV window, a dashboard's dialog - and so hear every change. */
const pages = new Set<WebContents>();
let busy = false;
let searcher: WebContents | null = null;
let state: TvInstallState = {
    phase: "ready",
    found: [],
    usb: null,
    usbListing: false,
    outcome: null,
    backup: null,
    closed: null,
    waiting: null,
    home: null,
    linking: null,
    named: {},
    control: null
};

function publish(next: Partial<TvInstallState>): void {
    state = { ...state, ...next };
    for (const page of pages) if (!page.isDestroyed()) page.send(CHANNELS.tvEvent, state);
}

async function closeAdb(adb: AdbConnection, target: TvTarget): Promise<boolean> {
    await adb.shell("settings put global adb_wifi_enabled 0; settings put global adb_enabled 0").catch(() => "");
    adb.close();
    for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt += 1) {
        if (target.kind === "usb") {
            // Debugging off takes the ADB interface off the cable.
            const still = await usbDevices().catch(() => null);
            if (still && !still.some((one) => one.id === target.id)) return true;
        } else if ((await answersOn(target.host, ADB_PORT, SCAN_MS)) === "refused") return true;
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

/** What a failed pairing means on screen. */
export function pairingFailure(caught: unknown): TvOutcome | "cancelled" {
    if (!(caught instanceof PairingError)) return "unreachable";
    if (caught.reason === "cancelled") return "cancelled";
    return caught.reason === "wrong-code" ? "pairing-refused" : "unreachable";
}

/**
 * A TV whose debugging opens only through Wireless debugging: its TLS port lets
 * in a computer it paired with before; otherwise the six-digit code the TV shows
 * pairs this one first. The pairing port is announced only while the TV shows
 * that code, so it is looked for again once the code is typed.
 */
async function overWirelessDebugging(
    host: string,
    key: string,
    heard: ReadonlyMap<string, TvAnnouncement>,
    code: string | null
): Promise<AdbConnection | TvOutcome | "cancelled"> {
    const certificate = adbCertificate(key);
    // A Stop pressed while a connect is under way closes it; that failure is the cancel, not the TV's answer.
    waitRun += 1;
    const run = waitRun;
    const stopped = () => run !== waitRun;
    const connectOn = async (port: number): Promise<AdbConnection> => {
        const adb = new AdbConnection({ host, port, key, certificate, connectMs: 8_000, approveMs: 60_000, commandMs: 60_000 });
        pending = adb;
        try {
            await adb.open();
            return adb;
        } catch (caught) {
            adb.close();
            throw caught;
        } finally {
            pending = null;
        }
    };
    const portsNow = async () => ({ ...heard.get(host)?.ports, ...(await browseTvs(INSTALL_BROWSE_MS).catch(() => new Map<string, TvAnnouncement>())).get(host)?.ports });
    let ports = heard.get(host)?.ports ?? {};
    if (!code) {
        const remembered = ports["adb-tls-connect"];
        if (remembered) {
            const adb = await connectOn(remembered).catch(() => null);
            if (adb) return adb;
            if (stopped()) return "cancelled";
        }
        const fresh = (await portsNow())["adb-tls-connect"];
        if (stopped()) return "cancelled";
        if (!fresh || fresh === remembered) return "needs-pairing";
        return connectOn(fresh).catch(() => (stopped() ? ("cancelled" as const) : ("needs-pairing" as const)));
    }
    ports = await portsNow();
    if (stopped()) return "cancelled";
    const pairingPort = ports["adb-tls-pairing"];
    if (!pairingPort) return "needs-pairing";
    const controller = new AbortController();
    pairing = controller;
    try {
        await pairTv({ host, port: pairingPort, code, key, publicKey: androidPublicKey(key), timeoutMs: 30_000, signal: controller.signal });
    } catch (caught) {
        console.error("[tv] pairing", caught);
        return pairingFailure(caught);
    } finally {
        if (pairing === controller) pairing = null;
    }
    if (!ports["adb-tls-connect"]) ports = await portsNow();
    const tlsPort = ports["adb-tls-connect"];
    if (!tlsPort) return "unreachable";
    return connectOn(tlsPort).catch((caught: NodeJS.ErrnoException) => (stopped() ? ("cancelled" as const) : connectFailure(caught)));
}

async function install(target: TvTarget, mode: TvInstallMode, blockAds: boolean, code: string | null = null): Promise<void> {
    publish({ phase: "download", outcome: null, backup: null, closed: null, waiting: null, home: null, linking: null, control: null });
    const makeHome = mode === "system";
    const release = await latestTvRelease().catch((caught: unknown) => {
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
    // A typed address nobody searched for is asked about here, so a pairing-only TV is known at once.
    const [adbOpen, heard] =
        target.kind === "network"
            ? await Promise.all([
                  answersOn(target.host, ADB_PORT, SCAN_MS).then((verdict) => verdict === "open"),
                  announced.has(target.host)
                      ? Promise.resolve(announced)
                      : browseTvs(INSTALL_BROWSE_MS).catch(() => new Map<string, TvAnnouncement>())
              ])
            : [false, new Map<string, TvAnnouncement>()];
    const sighting = sightingOf(target.kind === "network" ? heard.get(target.host) : undefined, adbOpen);
    const before = choosePath(sighting);
    let adb: AdbConnection;
    if (target.kind === "network" && before.route === "pairing") {
        const reached = await overWirelessDebugging(target.host, key, heard, code);
        if (reached === "cancelled") {
            publish({ phase: "ready", waiting: null });
            return;
        }
        if (typeof reached === "string") {
            publish({ phase: "failed", outcome: reached, waiting: null });
            return;
        }
        adb = reached;
    } else {
        waitRun += 1;
        const run = waitRun;
        const waited = await waitForTv<AdbConnection>({
            probe: () => (target.kind === "usb" ? Promise.resolve("open") : answersOn(target.host, ADB_PORT, SCAN_MS)),
            connect: async () => {
                const adb = new AdbConnection({
                    ...(target.kind === "usb" ? { link: usbLink(target.id) } : { host: target.host, port: ADB_PORT }),
                    key,
                    connectMs: 8_000,
                    approveMs: 60_000,
                    commandMs: 60_000,
                    onPrompt: () => publish({ phase: "allow", waiting: waitingFor("prompt", before) })
                });
                pending = adb;
                try {
                    await adb.open();
                    return adb;
                } catch (caught) {
                    adb.close();
                    throw caught;
                } finally {
                    pending = null;
                }
            },
            classify: (caught) => connectFailure(caught as NodeJS.ErrnoException),
            onStep: (step) => publish({ phase: step === "prompt" ? "allow" : "connecting", waiting: waitingFor(step, before) }),
            cancelled: () => run !== waitRun,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            now: () => Date.now(),
            intervalMs: WAIT_EVERY_MS,
            timeoutMs: WAIT_FOR_MS
        });
        waitRun += 1;
        if (waited.kind === "cancelled") {
            publish({ phase: "ready", waiting: null });
            return;
        }
        if (waited.kind !== "connected") {
            publish({ phase: "failed", outcome: waitOutcome(waited), waiting: null });
            return;
        }
        adb = waited.connection;
    }
    publish({ waiting: null });

    let stage: TvStage = "check";
    try {
        publish({ phase: "checking" });
        const sdk = await adb.shell("getprop ro.build.version.sdk");
        const refusal = tvRefusal(sdk, await adb.shell("pm list features"));
        if (refusal) {
            await finish(adb, target, refusal);
            return;
        }
        const path = choosePath(sighting, {
            manufacturer: await adb.shell("getprop ro.product.manufacturer"),
            model: await adb.shell("getprop ro.product.model"),
            sdk: Number.parseInt(sdk.trim(), 10) || null,
            homeGuard: listsPackage(await adb.shell(`pm list packages ${HOME_GUARD_PACKAGE}`), HOME_GUARD_PACKAGE)
        });
        publish({ home: path.home });
        // A box that uninstalls Home apps at boot gets the edition without the HOME category, so the APK is
        // fetched, from the release looked up before connecting, once the TV said which it is.
        publish({ phase: "download" });
        const fetched = await apkOf(release, path.edition).catch((caught: unknown) => {
            console.error("[tv]", caught);
            return undefined;
        });
        if (!fetched) {
            const unreleased = path.edition === "standard" ? "not-released" : "home-key-not-released";
            await finish(adb, target, fetched === null ? unreleased : "download-failed");
            return;
        }
        stage = "backup";
        publish({ phase: "backup" });
        publish({ backup: await backUp(adb, target) });

        stage = "send";
        publish({ phase: "install" });
        await adb.push(REMOTE_APK, fetched.apk);
        stage = "install";
        const installed = await adb.shell(`pm install -r ${REMOTE_APK}`, 180_000);
        await adb.shell(`rm -f ${REMOTE_APK}`).catch(() => "");
        if (!installed.includes("Success")) {
            await finish(adb, target, /VERIFICATION_FAILURE/.test(installed) ? "sideload-refused" : "install-failed");
            return;
        }
        stage = "home";
        for (const grant of grantCommands(blockAds)) await adb.shell(grant).catch(() => "");
        // TCL's app-ops: a TV without that firmware answers an error, which changes nothing.
        for (const line of path.afterInstall) await adb.shell(`${line} 2>/dev/null; true`).catch(() => "");

        let outcome: TvOutcome = "installed";
        if (makeHome && path.home === "offered" && path.edition === "home-key") {
            // set-home-activity changes nothing on these boxes: the remote's Home key opens it instead.
            publish({ phase: "home" });
            const entries = accessibilityEntries(await adb.shell(ACCESSIBILITY_READ));
            if (entries) for (const command of homeKeyCommands(entries)) await adb.shell(command);
            outcome = homeKeyOn(await adb.shell(HOME_KEY_READ)) ? "installed-home-key" : "installed-home-key-off";
        } else if (makeHome && path.home === "offered") {
            publish({ phase: "home" });
            await adb.shell(`cmd package set-home-activity --user 0 ${HOME_ACTIVITY}`);
            const resolved = await adb.shell(
                "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME"
            );
            outcome = homeIsOurs(resolved) ? "installed-home" : "installed-home-refused";
        }
        if (mode === "system") {
            // Each level past Home is tried and checked on its own; none of them can fail the install.
            publish({ phase: "control" });
            publish({ control: [homeControl(path.home === "offered", outcome), ...(await grantControl(adb))] });
        } else publish({ control: [] });
        const link = linkCommand(serverAddress());
        if (link && !alreadyLinked(await adb.shell(LINK_STATE_READ).catch(() => ""))) {
            publish({ linking: opened(await adb.shell(link).catch(() => "Error")) });
        }
        await finish(adb, target, outcome);
    } catch (caught) {
        console.error("[tv]", caught);
        await finish(adb, target, lateFailure(stage));
    }
}

async function finish(adb: AdbConnection, target: TvTarget, outcome: TvOutcome): Promise<void> {
    publish({ phase: "closing" });
    const closed = await closeAdb(adb, target);
    publish({ phase: outcome.startsWith("installed") ? "done" : "failed", outcome, closed });
}

/** Stops a search, or a wait for the TV, under way; an install is never stopped once the TV let this in. */
function stopSearch(by?: WebContents): void {
    pairing?.abort();
    if (state.waiting || state.phase === "connecting") {
        waitRun += 1;
        // A prompt nobody answered would otherwise hold the cancel until it times out.
        pending?.close();
    }
    if (state.phase !== "searching" || (by && searcher !== by)) return;
    searcher = null;
    search += 1;
    busy = false;
    publish({ phase: "ready" });
}

/** The window. One at a time: a second click brings it forward. */
export function openTvInstall(): void {
    if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        return;
    }
    window = openLocalWindow("tv", { title: "Install on a TV - Polaris", width: 560, height: 620 });
    const contents = window.webContents;
    window.on("closed", () => {
        window = null;
        // Closing stops a search it started, as closing the dashboard dialog does.
        stopSearch(contents);
    });
}

/** `mode` from pages that know it; `home` alone from pages older than it. One of them is required. */
const choiceShape = {
    mode: z.enum(["system", "app"]).optional(),
    home: z.boolean().optional(),
    blockAds: z.boolean().optional()
};

export const startSchema = z.union([
    z.object({
        host: z.unknown().transform(readTvAddress).pipe(z.string()),
        ...choiceShape,
        /** The Wireless debugging pairing code the TV shows; absent until it asked for one. */
        code: z.string().max(32).optional()
    }),
    z.object({ usb: z.string().trim().min(1).max(200), ...choiceShape })
]).refine((input) => input.mode !== undefined || input.home !== undefined);

/** Where a start asked to install; a USB id only counts if it was listed. */
export function startTarget(input: z.infer<typeof startSchema>, listed: readonly { readonly id: string; }[] | null): TvTarget | null {
    if ("host" in input) return { kind: "network", host: input.host };
    return listed?.some((one) => one.id === input.usb) ? { kind: "usb", id: input.usb } : null;
}

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
        stopSearch();
        return state;
    });
    ipcMain.handle(CHANNELS.tvFind, async (event) => {
        if (!fromTv(event)) return null;
        if (busy) return state;
        busy = true;
        search += 1;
        searcher = event.sender;
        const run = search;
        publish({ phase: "searching", found: [] });
        const { found, heard } = await findTvs(run).catch(() => ({ found: [], heard: new Map<string, TvAnnouncement>() }));
        // A cancelled search has already handed the controls back.
        if (run !== search) return state;
        busy = false;
        searcher = null;
        announced = heard;
        publish({ phase: "ready", found, named: namesOf(heard) });
        return state;
    });
    ipcMain.handle(CHANNELS.tvFindUsb, async (event) => {
        if (!fromTv(event)) return null;
        if (busy) return state;
        busy = true;
        publish({ usbListing: true });
        const usb = await usbDevices().catch((caught: unknown) => {
            console.error("[tv]", caught);
            return [];
        });
        busy = false;
        publish({ usb, usbListing: false, outcome: null });
        return state;
    });
    ipcMain.handle(CHANNELS.tvStart, async (event, raw: unknown) => {
        const input = startSchema.safeParse(raw);
        if (!fromTv(event) || !input.success || busy) return false;
        const target = startTarget(input.data, state.usb);
        const typed = "code" in input.data ? input.data.code : undefined;
        const code = typed === undefined ? null : readPairingCode(typed);
        if (!target || (typed !== undefined && !code)) return false;
        busy = true;
        void install(target, installMode(input.data), input.data.blockAds === true, code).finally(() => {
            busy = false;
        });
        return true;
    });
}
