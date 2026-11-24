/**
 * Add-ons installed on this device: their files under `<dir>/packages/<id>/<version>`,
 * their settings under `<dir>/settings/<id>.json`, and one `installed.json` saying
 * which are installed, at which version, enabled or not, and with which
 * permissions the person accepted.
 *
 * A package is downloaded only when it is installed, checked against the
 * SHA-256 the signed catalog names before a byte of it is unpacked, and its own
 * manifest must agree with the catalog's. Uninstalling removes all three, so
 * nothing is left behind.
 */

import { z } from "zod";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { writeWhole, type Fetcher } from "./catalog";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
    ADDON_PERMISSIONS,
    addonFit,
    compareAddonVersions,
    readAddonManifest,
    readAddonSettingValues,
    type AddonEntry,
    type AddonManifest,
    type AddonPermission,
    type AddonPlatform,
    type AddonSettingValue
} from "@polaris/core/device-addons";

const grantedSchema = z.array(z.enum(ADDON_PERMISSIONS));

// Every field after `installedAt` is optional, so a file an earlier app wrote reads as it was.
const installedSchema = z.object({
    schema: z.literal(1),
    /** Whether updates are put in by themselves; absent means yes, the way the app updates itself. */
    autoUpdate: z.boolean().optional(),
    addons: z.record(
        z.string(),
        z.object({
            version: z.string(),
            enabled: z.boolean(),
            granted: grantedSchema,
            installedAt: z.string(),
            /** This add-on's own choice; absent follows `autoUpdate` above. */
            autoUpdate: z.boolean().optional(),
            /** The version it was updated from, kept on disk to go back to when this one fails. */
            previous: z.object({ version: z.string(), granted: grantedSchema }).optional(),
            /** The last version the person was told about, so each one is announced once. */
            notified: z.string().optional(),
            /** A version that failed and was rolled back from: not put in by itself again. */
            failed: z.string().optional()
        })
    )
});

export type Installed = z.infer<typeof installedSchema>;
export type InstalledAddon = Installed["addons"][string];

/** A fresh empty record each time: callers change what they are given before saving it. */
const empty = (): Installed => ({ schema: 1, addons: {} });
/** The most files and unpacked bytes one package may hold. */
const MAX_FILES = 2_000;
const MAX_UNPACKED = 400 * 1024 * 1024;

export async function readInstalled(dir: string): Promise<Installed> {
    try {
        const parsed = installedSchema.safeParse(JSON.parse(await readFile(join(dir, "installed.json"), "utf8")));
        return parsed.success ? parsed.data : empty();
    } catch {
        return empty();
    }
}

async function saveInstalled(dir: string, installed: Installed): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeWhole(join(dir, "installed.json"), JSON.stringify(installed));
}

export function packageDir(dir: string, id: string, version: string): string {
    return join(dir, "packages", id, version);
}

/** Whether a path inside an archive stays inside the folder it is unpacked into. */
export function safeArchivePath(path: string): boolean {
    if (path.length === 0 || path.length > 300 || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
    return !path.split("/").some((part) => part === ".." || part === ".");
}

export type InstallFailure = "platform" | "app-version" | "permissions" | "download" | "size" | "hash" | "archive" | "manifest";
export type InstallResult = { readonly ok: true; readonly manifest: AddonManifest; } | { readonly ok: false; readonly reason: InstallFailure; };

export interface InstallOptions {
    readonly dir: string;
    readonly entry: AddonEntry;
    readonly platform: AddonPlatform | null;
    readonly appVersion: string;
    /** The permissions the person accepted: every one the add-on asks for, or it is not installed. */
    readonly accepted: readonly AddonPermission[];
    readonly fetcher: Fetcher;
    readonly onProgress?: (received: number, total: number) => void;
    readonly now?: () => Date;
}

async function download(url: string, size: number, fetcher: Fetcher, onProgress?: (received: number, total: number) => void): Promise<Uint8Array | "download" | "size"> {
    let response: Response;
    try {
        response = await fetcher(url, { signal: AbortSignal.timeout(10 * 60_000) });
    } catch {
        return "download";
    }
    if (!response.ok || !response.body) return "download";
    const out = new Uint8Array(size);
    let received = 0;
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (received + value.byteLength > size) {
                await reader.cancel();
                return "size";
            }
            out.set(value, received);
            received += value.byteLength;
            onProgress?.(received, size);
        }
    } catch {
        return "download";
    }
    return received === size ? out : "size";
}

/** The package's own manifest agrees with what the catalog promised about it. */
function sameAddon(packaged: AddonManifest, entry: AddonEntry): boolean {
    const set = (list: readonly string[]) => [...list].sort().join(",");
    const entries = (map: Readonly<Partial<Record<string, string>>>) => JSON.stringify(Object.entries(map).filter(([, path]) => path).sort());
    return (
        packaged.id === entry.id &&
        packaged.version === entry.version &&
        set(packaged.permissions) === set(entry.permissions) &&
        entries(packaged.entries) === entries(entry.entries) &&
        JSON.stringify(packaged.claims) === JSON.stringify(entry.claims)
    );
}

/**
 * Install the entry, or update it to the entry's version. On an update the
 * version it replaces stays on disk as `previous`, to go back to when the new
 * one fails (`rollbackAddon`); the one before that is removed.
 */
export async function installAddon(options: InstallOptions): Promise<InstallResult> {
    const { dir, entry } = options;
    const fit = addonFit(entry, options.platform, options.appVersion);
    if (!fit.ok) return { ok: false, reason: fit.reason };
    if (!entry.permissions.every((permission) => options.accepted.includes(permission))) return { ok: false, reason: "permissions" };
    const bytes = await download(fit.package.url, fit.package.size, options.fetcher, options.onProgress);
    if (typeof bytes === "string") return { ok: false, reason: bytes };
    if (createHash("sha256").update(bytes).digest("hex") !== fit.package.sha256) return { ok: false, reason: "hash" };
    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(bytes);
    } catch {
        return { ok: false, reason: "archive" };
    }
    const names = Object.keys(files).filter((name) => !name.endsWith("/"));
    const unpacked = names.reduce((sum, name) => sum + (files[name]?.byteLength ?? 0), 0);
    if (names.length > MAX_FILES || unpacked > MAX_UNPACKED || !names.every(safeArchivePath)) return { ok: false, reason: "archive" };
    let packaged: AddonManifest | null = null;
    try {
        const manifestBytes = files["manifest.json"];
        packaged = manifestBytes ? readAddonManifest(JSON.parse(Buffer.from(manifestBytes).toString("utf8"))) : null;
    } catch {
        packaged = null;
    }
    if (!packaged || !sameAddon(packaged, entry)) return { ok: false, reason: "manifest" };
    const platformEntry = options.platform ? packaged.entries[options.platform] : undefined;
    if (!platformEntry || !files[platformEntry]) return { ok: false, reason: "manifest" };

    // Unpacked beside its final place and renamed into it, so a half-written package never exists under its name.
    const target = packageDir(dir, entry.id, entry.version);
    const staging = `${target}.staging`;
    await rm(staging, { recursive: true, force: true });
    try {
        for (const name of names) {
            const path = join(staging, ...name.split("/"));
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, files[name]!);
        }
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
    } catch {
        await rm(staging, { recursive: true, force: true });
        return { ok: false, reason: "archive" };
    }

    const installed = await readInstalled(dir);
    const previous = installed.addons[entry.id];
    const replaced = previous && previous.version !== entry.version ? { version: previous.version, granted: previous.granted } : previous?.previous;
    installed.addons[entry.id] = {
        version: entry.version,
        enabled: previous?.enabled ?? true,
        granted: [...entry.permissions],
        installedAt: (options.now?.() ?? new Date()).toISOString(),
        ...(previous?.autoUpdate === undefined ? {} : { autoUpdate: previous.autoUpdate }),
        ...(replaced ? { previous: replaced } : {}),
        ...(previous?.notified === undefined ? {} : { notified: previous.notified }),
        // Put in on purpose, or a later one: the failure no longer stands in its way.
        ...(previous?.failed && previous.failed !== entry.version && compareAddonVersions(previous.failed, entry.version) > 0 ? { failed: previous.failed } : {})
    };
    await saveInstalled(dir, installed);
    await pruneVersions(dir, entry.id, [entry.version, replaced?.version]);
    return { ok: true, manifest: packaged };
}

/**
 * Remove every version folder of one add-on but those kept. Never throws: by
 * now the install is written down, and a folder Windows will not let go of
 * (a native module still loaded by the process being replaced) is only a
 * leftover, removed by a later install. An app up to 0.1.96 failed the whole
 * install here and left such folders behind.
 */
async function pruneVersions(dir: string, id: string, keep: readonly (string | undefined)[]): Promise<void> {
    const root = join(dir, "packages", id);
    const versions = await readdir(root).catch(() => [] as string[]);
    for (const version of versions) {
        if (keep.includes(version) || version.startsWith(".")) continue;
        await rm(join(root, version), { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * Go back to the version an update replaced: its files are still on disk. The
 * failed version is removed and remembered, so it is not put in by itself again.
 * Null when there is nothing to go back to.
 */
export async function rollbackAddon(dir: string, id: string): Promise<{ from: string; to: string; } | null> {
    const installed = await readInstalled(dir);
    const addon = installed.addons[id];
    const previous = addon?.previous;
    if (!addon || !previous || previous.version === addon.version) return null;
    if (!(await installedManifest(dir, id, previous.version))) return null;
    const from = addon.version;
    const back: InstalledAddon = { ...addon, version: previous.version, granted: previous.granted, failed: from };
    delete back.previous;
    installed.addons[id] = back;
    await saveInstalled(dir, installed);
    await rm(packageDir(dir, id, from), { recursive: true, force: true }).catch(() => undefined);
    return { from, to: previous.version };
}

/** Change one field of the installed record without touching the rest. False when it is not installed. */
export async function updateInstalled(dir: string, change: (installed: Installed) => boolean): Promise<boolean> {
    const installed = await readInstalled(dir);
    if (!change(installed)) return false;
    await saveInstalled(dir, installed);
    return true;
}

/** Remove the add-on's files, settings and record. Removing one that is not installed is not an error. */
export async function uninstallAddon(dir: string, id: string): Promise<void> {
    const installed = await readInstalled(dir);
    delete installed.addons[id];
    await saveInstalled(dir, installed);
    await rm(join(dir, "packages", id), { recursive: true, force: true });
    await rm(join(dir, "settings", `${id}.json`), { force: true });
}

export async function setAddonEnabled(dir: string, id: string, enabled: boolean): Promise<boolean> {
    const installed = await readInstalled(dir);
    const addon = installed.addons[id];
    if (!addon) return false;
    if (addon.enabled !== enabled) {
        addon.enabled = enabled;
        await saveInstalled(dir, installed);
    }
    return true;
}

/** The manifest of an installed add-on, read from its own files. */
export async function installedManifest(dir: string, id: string, version: string): Promise<AddonManifest | null> {
    try {
        const manifest = readAddonManifest(JSON.parse(await readFile(join(packageDir(dir, id, version), "manifest.json"), "utf8")));
        return manifest && manifest.id === id && manifest.version === version ? manifest : null;
    } catch {
        return null;
    }
}

export async function readAddonSettings(dir: string, manifest: AddonManifest): Promise<Record<string, AddonSettingValue>> {
    let stored: unknown = {};
    try {
        stored = JSON.parse(await readFile(join(dir, "settings", `${manifest.id}.json`), "utf8"));
    } catch {
        stored = {};
    }
    return readAddonSettingValues(manifest.settings, stored);
}

export async function writeAddonSettings(dir: string, id: string, values: Record<string, AddonSettingValue>): Promise<void> {
    await mkdir(join(dir, "settings"), { recursive: true });
    await writeWhole(join(dir, "settings", `${id}.json`), JSON.stringify(values));
}
