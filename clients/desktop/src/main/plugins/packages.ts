/**
 * Plugins installed on this device: their files under `<dir>/packages/<id>/<version>`,
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
import { existsSync, renameSync } from "node:fs";
import { writeWhole, type Fetcher } from "./catalog";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
    PLUGIN_PERMISSIONS,
    pluginFit,
    comparePluginVersions,
    readPluginManifest,
    readPluginSettingValues,
    readPluginProfiles,
    type PluginProfiles,
    type PluginEntry,
    type PluginManifest,
    type PluginPermission,
    type PluginPlatform,
    type PluginSettingValue
} from "@polaris/core/device-plugins";

const grantedSchema = z.array(z.enum(PLUGIN_PERMISSIONS));

// Every field after `installedAt` is optional, so a file an earlier app wrote reads as it was.
const installedFields = z.object({
    schema: z.literal(1),
    /** Whether updates are put in by themselves; absent means yes, the way the app updates itself. */
    autoUpdate: z.boolean().optional(),
    plugins: z.record(
        z.string(),
        z.object({
            version: z.string(),
            enabled: z.boolean(),
            granted: grantedSchema,
            installedAt: z.string(),
            /** This plugin's own choice; absent follows `autoUpdate` above. */
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

/** A file written before the rename lists its plugins under `addons`: read as written, saved under the new name. */
const installedSchema = z.preprocess(
    (value) => (value !== null && typeof value === "object" && !("plugins" in value) && "addons" in value ? { ...value, plugins: value.addons } : value),
    installedFields
);

export type Installed = z.infer<typeof installedSchema>;
export type InstalledPlugin = Installed["plugins"][string];

/** A fresh empty record each time: callers change what they are given before saving it. */
const empty = (): Installed => ({ schema: 1, plugins: {} });
/** The most files and unpacked bytes one package may hold. */
const MAX_FILES = 2_000;
const MAX_UNPACKED = 400 * 1024 * 1024;

/**
 * The folder plugins live in under the app's data folder. It was `addons`
 * before the rename: moved once, the first time an app after it starts, and
 * used where it is when it cannot be moved (a file in it held open).
 * Removable once no supported desktop app or host predates the rename (desktop 0.1.124).
 */
export function pluginsFolder(userData: string): string {
    const folder = join(userData, "plugins");
    const legacy = join(userData, "addons");
    if (existsSync(folder) || !existsSync(legacy)) return folder;
    try {
        renameSync(legacy, folder);
        return folder;
    } catch {
        return legacy;
    }
}

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
export type InstallResult = { readonly ok: true; readonly manifest: PluginManifest; } | { readonly ok: false; readonly reason: InstallFailure; };

export interface InstallOptions {
    readonly dir: string;
    readonly entry: PluginEntry;
    readonly platform: PluginPlatform | null;
    readonly appVersion: string;
    /** The permissions the person accepted: every one the plugin asks for, or it is not installed. */
    readonly accepted: readonly PluginPermission[];
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
function samePlugin(packaged: PluginManifest, entry: PluginEntry): boolean {
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
 * one fails (`rollbackPlugin`); the one before that is removed.
 */
export async function installPlugin(options: InstallOptions): Promise<InstallResult> {
    const { dir, entry } = options;
    const fit = pluginFit(entry, options.platform, options.appVersion);
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
    let packaged: PluginManifest | null = null;
    try {
        const manifestBytes = files["manifest.json"];
        packaged = manifestBytes ? readPluginManifest(JSON.parse(Buffer.from(manifestBytes).toString("utf8"))) : null;
    } catch {
        packaged = null;
    }
    if (!packaged || !samePlugin(packaged, entry)) return { ok: false, reason: "manifest" };
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
    const previous = installed.plugins[entry.id];
    const replaced = previous && previous.version !== entry.version ? { version: previous.version, granted: previous.granted } : previous?.previous;
    installed.plugins[entry.id] = {
        version: entry.version,
        enabled: previous?.enabled ?? true,
        granted: [...entry.permissions],
        installedAt: (options.now?.() ?? new Date()).toISOString(),
        ...(previous?.autoUpdate === undefined ? {} : { autoUpdate: previous.autoUpdate }),
        ...(replaced ? { previous: replaced } : {}),
        ...(previous?.notified === undefined ? {} : { notified: previous.notified }),
        // Put in on purpose, or a later one: the failure no longer stands in its way.
        ...(previous?.failed && previous.failed !== entry.version && comparePluginVersions(previous.failed, entry.version) > 0 ? { failed: previous.failed } : {})
    };
    await saveInstalled(dir, installed);
    await pruneVersions(dir, entry.id, [entry.version, replaced?.version]);
    return { ok: true, manifest: packaged };
}

/**
 * Remove every version folder of one plugin but those kept. Never throws: by
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
export async function rollbackPlugin(dir: string, id: string): Promise<{ from: string; to: string; } | null> {
    const installed = await readInstalled(dir);
    const plugin = installed.plugins[id];
    const previous = plugin?.previous;
    if (!plugin || !previous || previous.version === plugin.version) return null;
    if (!(await installedManifest(dir, id, previous.version))) return null;
    const from = plugin.version;
    const back: InstalledPlugin = { ...plugin, version: previous.version, granted: previous.granted, failed: from };
    delete back.previous;
    installed.plugins[id] = back;
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

/** Remove the plugin's files, settings and record. Removing one that is not installed is not an error. */
export async function uninstallPlugin(dir: string, id: string): Promise<void> {
    const installed = await readInstalled(dir);
    delete installed.plugins[id];
    await saveInstalled(dir, installed);
    await rm(join(dir, "packages", id), { recursive: true, force: true });
    await rm(join(dir, "settings", `${id}.json`), { force: true });
    await rm(join(dir, "settings", `${id}.profiles.json`), { force: true });
}

export async function setPluginEnabled(dir: string, id: string, enabled: boolean): Promise<boolean> {
    const installed = await readInstalled(dir);
    const plugin = installed.plugins[id];
    if (!plugin) return false;
    if (plugin.enabled !== enabled) {
        plugin.enabled = enabled;
        await saveInstalled(dir, installed);
    }
    return true;
}

/** The manifest of an installed plugin, read from its own files. */
export async function installedManifest(dir: string, id: string, version: string): Promise<PluginManifest | null> {
    try {
        const manifest = readPluginManifest(JSON.parse(await readFile(join(packageDir(dir, id, version), "manifest.json"), "utf8")));
        return manifest && manifest.id === id && manifest.version === version ? manifest : null;
    } catch {
        return null;
    }
}

export async function readPluginSettings(dir: string, manifest: PluginManifest): Promise<Record<string, PluginSettingValue>> {
    let stored: unknown = {};
    try {
        stored = JSON.parse(await readFile(join(dir, "settings", `${manifest.id}.json`), "utf8"));
    } catch {
        stored = {};
    }
    return readPluginSettingValues(manifest.settings, stored);
}

export async function writePluginSettings(dir: string, id: string, values: Record<string, PluginSettingValue>): Promise<void> {
    await mkdir(join(dir, "settings"), { recursive: true });
    await writeWhole(join(dir, "settings", `${id}.json`), JSON.stringify(values));
}

/**
 * Its profiles besides Default, kept beside the settings file rather than in
 * it: the settings file stays exactly what an app older than profiles reads
 * and writes, so going back to one loses nothing and Default is what it had.
 */
export async function readPluginProfilesFile(dir: string, manifest: PluginManifest): Promise<PluginProfiles> {
    let stored: unknown = {};
    try {
        stored = JSON.parse(await readFile(join(dir, "settings", `${manifest.id}.profiles.json`), "utf8"));
    } catch {
        stored = {};
    }
    return readPluginProfiles(manifest.settings, stored);
}

export async function writePluginProfilesFile(dir: string, id: string, profiles: PluginProfiles): Promise<void> {
    await mkdir(join(dir, "settings"), { recursive: true });
    await writeWhole(join(dir, "settings", `${id}.profiles.json`), JSON.stringify(profiles));
}
