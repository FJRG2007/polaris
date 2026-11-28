/**
 * What Windows' own search misses and the launcher should still find: Store
 * and Xbox apps, and games that their store installs without a Start menu
 * shortcut (Epic never makes one, Steam and Ubisoft often do not).
 *
 * Each store is read where it keeps its own list - the places Playnite's
 * library plugins read (github.com/JosefNemec/PlayniteExtensions,
 * `source/Libraries/*Library`) - once per listing, every file bounded in size
 * and every record checked against a schema before it is used. A game is
 * launched the way its store launches it: a fixed URI scheme with ids that were
 * checked here, or, for GOG, the primary executable its own `goggame-*.info`
 * names inside the game's folder. Nothing is ever run through a shell.
 *
 * A game its store is updating stays listed, marked `updating`: its old build
 * is still on disk and the store's own link finishes the update before it
 * starts. Only a first install that never completed is left out. GOG and
 * Ubisoft keep a game's registry entry through an update, so they never hid one.
 */

import { z } from "zod";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { win32 } from "node:path";
import * as icons from "./launcher-icons";

/** Every path here is a Windows path from a store or the registry, whatever machine runs the code. */
const { basename, isAbsolute, join, normalize, sep } = win32;

/** How a listed program is started. */
export type AppLaunch =
    /** Handed to the shell as a double-click would: a Start menu shortcut, a macOS bundle. */
    | { readonly kind: "open"; readonly path: string; }
    /** A store's own launch link, from `isVettedLaunchUri`. */
    | { readonly kind: "uri"; readonly uri: string; }
    /** A packaged (Store, Xbox) app, by its AppUserModelID. */
    | { readonly kind: "packaged"; readonly id: string; }
    /**
     * An executable inside a game's own folder, started there - with no
     * arguments, or a store launcher's own launch arguments built from its
     * registry entry (`launcher-programs.ts`), never from typed text.
     */
    | { readonly kind: "exe"; readonly path: string; readonly cwd: string; readonly args?: readonly string[]; };

export interface StoreApp {
    readonly label: string;
    /** Unique per program, also the key the launcher's rows are opened by. */
    readonly path: string;
    readonly launch: AppLaunch;
    /** A file to take the row's picture from: an executable, or an image the store keeps. */
    readonly icon?: string;
    /** The game's own install folder, so a program running from inside it is known as this game. */
    readonly folder?: string;
    /** The store's own id for the game (`steam:252950`, `epic:<namespace>:<catalog item>`),
     *  reported beside a running game so the dashboard can find the store's art. */
    readonly store?: string;
    /** Its store is updating it: still listed and opened as usual, the store finishing the update first. */
    readonly updating?: true;
}

/** The largest store file read: a manifest is a few KB, a library list a few more. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PER_STORE = 1000;
const MAX_LIBRARIES = 32;
/** The longest a registry or PowerShell read may take, and how much it may print. */
const COMMAND_MS = 15_000;
const COMMAND_BYTES = 4 * 1024 * 1024;

const ID = /^[A-Za-z0-9._-]{1,200}$/;
const AUMID = /^[A-Za-z0-9._-]{1,200}![A-Za-z0-9._-]{1,200}$/;
const LAUNCH_URIS = [
    /^steam:\/\/rungameid\/\d{1,10}$/,
    /^com\.epicgames\.launcher:\/\/apps\/[A-Za-z0-9._-]{1,200}%3A[A-Za-z0-9._-]{1,200}%3A[A-Za-z0-9._-]{1,200}\?action=launch&silent=true$/,
    /^uplay:\/\/launch\/\d{1,10}$/
];

/** Whether `uri` is one of the store launch links this module makes, with ids of the expected shape. */
export function isVettedLaunchUri(uri: string): boolean {
    return LAUNCH_URIS.some((pattern) => pattern.test(uri));
}

/** Whether `id` is a packaged app's AppUserModelID (`Family_hash!App`). */
export function isPackagedAppId(id: string): boolean {
    return AUMID.test(id);
}

const label = z.string().trim().min(1).max(300);
const folder = z.string().min(3).max(1000);

/** A file's contents when it exists and is small enough, else null. */
async function readBounded(path: string): Promise<string | null> {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
        return await readFile(path, "utf8");
    } catch {
        return null;
    }
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    const text = await readBounded(path);
    if (text === null) return null;
    try {
        const parsed = schema.safeParse(JSON.parse(text.replace(/^\uFEFF/, "")));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
}

/** `relative` inside `root`, or null when it climbs out of it or is absolute. */
function inside(root: string, relative: string): string | null {
    if (!relative || isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return null;
    const joined = normalize(join(root, relative));
    const base = normalize(root).replace(/[\\/]+$/, "") + sep;
    return joined.toLowerCase().startsWith(base.toLowerCase()) ? joined : null;
}

/** A program's output, or null when it failed, timed out or said too much. */
function run(file: string, args: readonly string[]): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            execFile(file, args, { timeout: COMMAND_MS, maxBuffer: COMMAND_BYTES, windowsHide: true, encoding: "utf8" }, (error, stdout) =>
                resolve(error ? null : stdout)
            );
        } catch {
            resolve(null);
        }
    });
}

/** One key of `reg query` output: its full path and its values by lower-cased name. */
export interface RegistryKey {
    readonly key: string;
    readonly values: ReadonlyMap<string, string>;
}

/**
 * `reg query` prints each key's path on a line of its own, then one line per
 * value: four spaces, the name, four spaces, the type, four spaces, the data.
 */
export function parseRegQuery(output: string): RegistryKey[] {
    const keys: { key: string; values: Map<string, string>; }[] = [];
    for (const line of output.split(/\r?\n/)) {
        if (/^HKEY_/.test(line)) {
            keys.push({ key: line.trim(), values: new Map() });
            continue;
        }
        const value = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
        const last = keys[keys.length - 1];
        if (value?.[1] && last) last.values.set(value[1].toLowerCase(), value[3] ?? "");
    }
    return keys;
}

/** `reg query` with these arguments: its output, or null when it failed. */
export function regQuery(args: readonly string[]): Promise<string | null> {
    return run("reg.exe", ["query", ...args]);
}

async function registry(args: readonly string[]): Promise<RegistryKey[]> {
    const output = await regQuery(args);
    return output ? parseRegQuery(output) : [];
}

/** A node of Valve's KeyValues text format: strings, or nested blocks. */
export type Vdf = { [key: string]: string | Vdf; };

/** Valve's KeyValues text (`.vdf`, `.acf`): quoted keys, quoted values or `{ }` blocks, `//` comments. */
export function parseVdf(text: string): Vdf | null {
    const tokens: string[] = [];
    const kinds: ("open" | "close" | "string")[] = [];
    let at = 0;
    while (at < text.length) {
        const char = text.charAt(at);
        if (/\s/.test(char)) at++;
        else if (char === "/" && text[at + 1] === "/") {
            const end = text.indexOf("\n", at);
            at = end === -1 ? text.length : end;
        } else if (char === "{" || char === "}") {
            kinds.push(char === "{" ? "open" : "close");
            tokens.push(char);
            at++;
        } else if (char === "\"") {
            let value = "";
            at++;
            while (at < text.length && text[at] !== "\"") {
                if (text[at] === "\\" && at + 1 < text.length) {
                    const next = text[at + 1];
                    value += next === "n" ? "\n" : next === "t" ? "\t" : next;
                    at += 2;
                } else value += text[at++];
            }
            if (at >= text.length) return null;
            at++;
            kinds.push("string");
            tokens.push(value);
        } else return null;
    }
    let index = 0;
    const block = (depth: number): Vdf | null => {
        const out: Vdf = Object.create(null);
        while (index < tokens.length) {
            if (kinds[index] === "close") {
                index++;
                return depth > 0 ? out : null;
            }
            if (kinds[index] !== "string" || index + 1 >= tokens.length) return null;
            const key = tokens[index++] as string;
            if (kinds[index] === "open") {
                index++;
                if (depth > 16) return null;
                const child = block(depth + 1);
                if (!child) return null;
                out[key] = child;
            } else if (kinds[index] === "string") out[key] = tokens[index++] as string;
            else return null;
        }
        return depth === 0 ? out : null;
    };
    return block(0);
}

/** A value of a VDF block by key, any case. */
function vdfGet(node: Vdf | undefined, key: string): string | Vdf | undefined {
    if (!node) return undefined;
    const found = Object.keys(node).find((name) => name.toLowerCase() === key.toLowerCase());
    return found === undefined ? undefined : node[found];
}

// --- Store and Xbox apps -----------------------------------------------------

const startAppSchema = z.object({ Name: label, AppID: z.string().regex(AUMID), Location: z.string().max(1000).nullish() });
const startAppsSchema = z.union([z.array(z.unknown()).max(5000), z.unknown()]);

/**
 * `Get-StartApps` with each app's package folder beside it (from
 * `Get-AppxPackage`, joined on the family name before the `!`), so its logo can
 * be read from the package's manifest. Fixed text, never built from input.
 */
export const PACKAGED_SCRIPT =
    "$at = @{}; Get-AppxPackage | ForEach-Object { $at[$_.PackageFamilyName] = $_.InstallLocation }; " +
    "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ForEach-Object { [pscustomobject]@{ Name = $_.Name; AppID = $_.AppID; Location = $at[($_.AppID -split '!')[0]] } } | ConvertTo-Json -Compress";

/**
 * The file a packaged app's logo is drawn from: the manifest's logo for that
 * app, in the variant `pickAsset` takes. Null when the package folder, its
 * manifest or the asset cannot be read.
 */
export async function packagedLogo(location: string | null | undefined, aumid: string): Promise<string | null> {
    if (!location || !folder.safeParse(location).success) return null;
    const manifest = await readBounded(join(location, "AppxManifest.xml"));
    const logo = manifest ? icons.manifestLogo(manifest, aumid.slice(aumid.indexOf("!") + 1)) : null;
    if (!logo) return null;
    const assets = icons.assetFolder(location, logo);
    if (!inside(location, logo)) return null;
    const name = icons.pickAsset(logo, await readdir(assets).catch(() => [] as string[]));
    return name ? join(assets, name) : null;
}

/**
 * The packaged apps the Start menu lists (Store, Xbox and Game Pass games),
 * from `Get-StartApps`: the same list Start shows, with the AppUserModelID
 * that opens each. Desktop programs in it are left out - their shortcuts are
 * already read from the Start menu's folders.
 */
export async function packagedApps(): Promise<StoreApp[]> {
    const script = PACKAGED_SCRIPT;
    const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!output?.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch {
        return [];
    }
    const list = startAppsSchema.parse(parsed);
    const out: StoreApp[] = [];
    for (const item of Array.isArray(list) ? list : [list]) {
        const app = startAppSchema.safeParse(item);
        if (!app.success || out.length >= MAX_PER_STORE) continue;
        const icon = await packagedLogo(app.data.Location, app.data.AppID);
        // A package that carries a MicrosoftGame.config is an Xbox / Store game.
        const location = app.data.Location && folder.safeParse(app.data.Location).success ? app.data.Location : null;
        const game = location !== null && (await exists(join(location, "MicrosoftGame.config")));
        out.push({
            label: app.data.Name,
            path: `packaged:${app.data.AppID}`,
            launch: { kind: "packaged", id: app.data.AppID },
            ...(icon ? { icon } : {}),
            ...(game && location ? { folder: location, store: `xbox:${app.data.AppID.split("!")[0]!.toLowerCase()}` } : {})
        });
    }
    return out;
}

// --- Epic Games --------------------------------------------------------------

const epicManifestSchema = z.object({
    DisplayName: label.optional(),
    AppName: z.string().regex(ID),
    CatalogNamespace: z.string().regex(ID),
    CatalogItemId: z.string().regex(ID),
    InstallLocation: folder,
    LaunchExecutable: z.string().max(500).optional(),
    bIsIncompleteInstall: z.boolean().optional(),
    AppCategories: z.array(z.string().max(100)).max(50).optional(),
    TechnicalType: z.string().max(200).optional(),
    MainGameAppName: z.string().max(200).optional(),
    bIsApplication: z.boolean().optional()
});

/**
 * The Epic Games Launcher's installed games: one `.item` JSON per install in
 * `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests`, launched with the
 * launcher's own link (Playnite's `EpicLauncher.GameLaunchUrlMask`). Add-ons
 * that cannot be launched and engine plugins are left out, as Playnite does,
 * and so is content installed inside another game (`MainGameAppName` names that
 * game, as Fortnite's "Save the World" and "LEGO Fortnite" content do): it is
 * part of the game, not something of its own to open.
 */
export async function epicGames(programData: string): Promise<StoreApp[]> {
    const dir = join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => /\.item$/i.test(name)).slice(0, MAX_PER_STORE);
    const out: StoreApp[] = [];
    for (const name of names) {
        const manifest = await readJson(join(dir, name), epicManifestSchema);
        if (!manifest) continue;
        const categories = manifest.AppCategories ?? [];
        if (categories.includes("addons") && !categories.includes("addons/launchable")) continue;
        if (categories.some((category) => category === "plugins" || category === "plugins/engine")) continue;
        if (manifest.TechnicalType?.includes("plugins/engine")) continue;
        if (manifest.MainGameAppName && manifest.MainGameAppName !== manifest.AppName) continue;
        if (manifest.bIsApplication === false) continue;
        if (!(await exists(manifest.InstallLocation))) continue;
        const exe = manifest.LaunchExecutable && /\.exe$/i.test(manifest.LaunchExecutable) ? inside(manifest.InstallLocation, manifest.LaunchExecutable) : null;
        // Epic marks a game incomplete for the whole of an update as well as
        // a first install: one whose executable is already there is installed.
        if (manifest.bIsIncompleteInstall && !(exe && (await exists(exe)))) continue;
        const uri = `com.epicgames.launcher://apps/${manifest.CatalogNamespace}%3A${manifest.CatalogItemId}%3A${manifest.AppName}?action=launch&silent=true`;
        out.push({
            label: manifest.DisplayName ?? basename(manifest.InstallLocation),
            path: `epic:${manifest.AppName}`,
            launch: { kind: "uri", uri },
            store: `epic:${manifest.CatalogNamespace}:${manifest.CatalogItemId}`,
            ...(exe ? { icon: exe } : {}),
            ...(manifest.bIsIncompleteInstall ? { updating: true as const } : {}),
            // An engine (`UE_5.3`) is not a game somebody is playing.
            ...(/^UE_/i.test(manifest.AppName) ? {} : { folder: manifest.InstallLocation })
        });
    }
    return out;
}

// --- Steam -------------------------------------------------------------------

/** Steam's own tools, which its library lists beside the games. */
const STEAM_TOOLS = new Set(["228980", "1070560", "1391110", "1628350", "1493710", "2180100"]);

/** `StateFlags` bits of a Steam app manifest (Steamworks `EAppState`). */
const STEAM_FULLY_INSTALLED = 4;
/** Update running, paused or started. */
const STEAM_UPDATING = 256 | 512 | 1024;
const STEAM_UNINSTALLING = 2048;

/** Whether a folder holds anything at all: a build already installed in it. */
async function hasFiles(dir: string): Promise<boolean> {
    return (await readdir(dir).catch(() => [] as string[])).length > 0;
}

async function steamRoots(programFilesX86: string | undefined): Promise<string[]> {
    const roots: string[] = [];
    const [key] = await registry(["HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]);
    const fromRegistry = key?.values.get("steampath");
    if (fromRegistry) roots.push(normalize(fromRegistry));
    if (programFilesX86) roots.push(join(programFilesX86, "Steam"));
    return roots.filter((root, at) => roots.findIndex((other) => other.toLowerCase() === root.toLowerCase()) === at);
}

/** The uninstall hives, 32-bit view first since Steam is a 32-bit program. */
const UNINSTALL_HIVES = [
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];

/**
 * The `DisplayIcon` of every `Steam App <id>` uninstall entry, by id: Steam
 * points it at the game's own icon in `steam\games\<hash>.ico`, the one its
 * desktop shortcuts use. One `reg` call per hive, only once a game is found.
 */
async function steamUninstallIcons(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const hive of UNINSTALL_HIVES) {
        for (const found of await registry([hive, "/s", "/v", "DisplayIcon"])) {
            const id = icons.steamUninstallId(found.key);
            const icon = icons.iconFile(found.values.get("displayicon"), process.env);
            if (id && icon && !out.has(id)) out.set(id, icon);
        }
    }
    return out;
}

/**
 * A Steam game's icon: its uninstall entry's `.ico`, else the library cache's
 * icon in either layout - `librarycache\<id>_icon.jpg` (older clients) or the
 * hashed file in `librarycache\<id>\` (newer ones). Null when none is on disk;
 * the row then takes the game's executable's icon (see `launcher-icons.ts`).
 */
async function steamIcon(root: string, id: string, uninstall: () => Promise<Map<string, string>>): Promise<string | null> {
    const registered = (await uninstall()).get(id);
    if (registered && (await exists(registered))) return registered;
    const cache = join(root, "appcache", "librarycache");
    const flat = join(cache, `${id}_icon.jpg`);
    if (await exists(flat)) return flat;
    const name = icons.steamFolderIcon(await readdir(join(cache, id)).catch(() => [] as string[]));
    return name ? join(cache, id, name) : null;
}

/**
 * Steam's installed games: every library folder `steamapps\libraryfolders.vdf`
 * lists, and an `appmanifest_<id>.acf` per game in each, launched with
 * `steam://rungameid/<id>` (Playnite's `SteamLibrary`). A first download is
 * left out until its manifest says it is fully installed; a game being updated
 * - no longer flagged fully installed, but with a build already installed in
 * its folder - stays listed as `updating`. A
 * soundtrack - installed under `steamapps\music` rather than `common` - is
 * music that belongs to a game, not a program.
 */
export async function steamGames(programFilesX86: string | undefined): Promise<StoreApp[]> {
    const out: StoreApp[] = [];
    const seen = new Set<string>();
    let uninstallIcons: Promise<Map<string, string>> | null = null;
    const uninstallIconsOnce = () => (uninstallIcons ??= steamUninstallIcons());
    for (const root of await steamRoots(programFilesX86)) {
        const libraries = [root];
        const listed = parseVdf((await readBounded(join(root, "steamapps", "libraryfolders.vdf"))) ?? "");
        const folders = vdfGet(listed ?? undefined, "libraryfolders");
        if (folders && typeof folders === "object") {
            for (const entry of Object.values(folders)) {
                const path = typeof entry === "object" ? vdfGet(entry, "path") : entry;
                if (typeof path === "string" && folder.safeParse(path).success) libraries.push(normalize(path));
            }
        }
        for (const library of [...new Set(libraries)].slice(0, MAX_LIBRARIES)) {
            const apps = join(library, "steamapps");
            const names = (await readdir(apps).catch(() => [] as string[])).filter((name) => /^appmanifest_\d+\.acf$/i.test(name));
            for (const name of names) {
                if (out.length >= MAX_PER_STORE) return out;
                const state = vdfGet(parseVdf((await readBounded(join(apps, name))) ?? "") ?? undefined, "AppState");
                if (!state || typeof state !== "object") continue;
                const id = vdfGet(state, "appid");
                const title = label.safeParse(vdfGet(state, "name"));
                const flags = Number(vdfGet(state, "StateFlags"));
                if (typeof id !== "string" || !/^\d{1,10}$/.test(id) || !title.success || STEAM_TOOLS.has(id) || seen.has(id)) continue;
                if (!Number.isFinite(flags) || (flags & STEAM_UNINSTALLING) !== 0) continue;
                if (/^(Steamworks|Steam Linux Runtime|Proton )/i.test(title.data)) continue;
                const installdir = vdfGet(state, "installdir");
                const home = typeof installdir === "string" ? inside(join(apps, "common"), installdir) : null;
                const music = typeof installdir === "string" ? inside(join(apps, "music"), installdir) : null;
                const installed = (flags & STEAM_FULLY_INSTALLED) !== 0;
                if (!installed && !(Number(vdfGet(state, "buildid")) > 0 && home && (await hasFiles(home)))) continue;
                const updating = !installed || (flags & STEAM_UPDATING) !== 0;
                seen.add(id);
                const icon = await steamIcon(root, id, uninstallIconsOnce);
                if (music && !(home && (await exists(home))) && (await exists(music))) continue;
                out.push({
                    label: title.data,
                    path: `steam:${id}`,
                    launch: { kind: "uri", uri: `steam://rungameid/${id}` },
                    store: `steam:${id}`,
                    ...(icon ? { icon } : {}),
                    ...(home ? { folder: home } : {}),
                    ...(updating ? { updating: true as const } : {})
                });
            }
        }
    }
    return out;
}

// --- GOG ---------------------------------------------------------------------

const gogInfoSchema = z.object({
    name: label.optional(),
    gameId: z.string().max(40).optional(),
    rootGameId: z.string().max(40).optional(),
    playTasks: z
        .array(
            z.object({
                isPrimary: z.boolean().optional(),
                type: z.string().max(40).optional(),
                path: z.string().max(500).optional(),
                workingDir: z.string().max(500).optional(),
                arguments: z.string().max(2000).optional()
            })
        )
        .max(50)
        .optional()
});

const UNINSTALL = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/**
 * GOG games: the uninstall entries GOG's installers write (`<id>_is1`,
 * publisher `GOG.com`), and the primary play task of the `goggame-<id>.info`
 * in each game's folder (Playnite's `GogLibrary`). The task is started only
 * when it is an executable inside that folder that takes no arguments. A DLC,
 * whose info names another game as its root, is part of that game.
 */
export async function gogGames(): Promise<StoreApp[]> {
    const out: StoreApp[] = [];
    const ids = new Set<string>();
    for (const hive of ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", `HKLM\\${UNINSTALL}`]) {
        for (const found of await registry([hive, "/s", "/f", "GOG.com", "/d", "/e"])) {
            const id = /\\(\d{1,12})_is1$/i.exec(found.key)?.[1];
            if (id && found.values.get("publisher") === "GOG.com") ids.add(`${hive}\\${id}_is1`);
        }
    }
    for (const key of [...ids].slice(0, MAX_PER_STORE)) {
        const [entry] = await registry([key]);
        const id = /\\(\d{1,12})_is1$/i.exec(key)?.[1] as string;
        const dir = entry?.values.get("installlocation");
        if (!dir || !folder.safeParse(dir).success || !(await exists(dir))) continue;
        const info = await readJson(join(dir, `goggame-${id}.info`), gogInfoSchema);
        if (info?.rootGameId && info.rootGameId !== (info.gameId ?? id)) continue;
        const task = info?.playTasks?.find((candidate) => candidate.isPrimary);
        if (!task || (task.type && task.type !== "FileTask") || task.arguments?.trim() || !task.path || !/\.exe$/i.test(task.path)) continue;
        const exe = inside(dir, task.path);
        const cwd = task.workingDir ? inside(dir, task.workingDir) : dir;
        if (!exe || !cwd) continue;
        const title = info?.name ?? entry?.values.get("displayname");
        if (!title) continue;
        out.push({ label: title, path: `gog:${id}`, launch: { kind: "exe", path: exe, cwd }, icon: exe, folder: dir, store: `gog:${id}` });
    }
    return out;
}

// --- Ubisoft Connect ---------------------------------------------------------

/**
 * Ubisoft Connect's installs: a key per game id under
 * `HKLM\SOFTWARE\ubisoft\Launcher\Installs` with its `InstallDir`, launched
 * with `uplay://launch/<id>` (Playnite's `UplayLibrary`). The folder's name is
 * the game's name, as Ubisoft names it on disk.
 */
export async function ubisoftGames(): Promise<StoreApp[]> {
    const out: StoreApp[] = [];
    for (const hive of ["HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs", "HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs"]) {
        for (const found of await registry([hive, "/s"])) {
            const id = /\\Installs\\(\d{1,10})$/i.exec(found.key)?.[1];
            const dir = found.values.get("installdir")?.replace(/\//g, "\\").replace(/\\+$/, "");
            if (!id || !dir || !folder.safeParse(dir).success || out.some((app) => app.path === `ubisoft:${id}`)) continue;
            if (!(await exists(dir))) continue;
            out.push({ label: basename(dir), path: `ubisoft:${id}`, launch: { kind: "uri", uri: `uplay://launch/${id}` }, folder: dir, store: `ubisoft:${id}` });
            if (out.length >= MAX_PER_STORE) return out;
        }
    }
    return out;
}

// --- Games a store keeps no launch link for -----------------------------------
//
// These stores are read for where a game lives, so a program started from that
// folder - or listed by a Start menu shortcut or an uninstall entry that points
// into it - is known as a game. They are not launched from here: the shortcut or
// the store's own entry already opens them. Where each keeps its list:
//   Rockstar Games Launcher  HKLM\SOFTWARE\WOW6432Node\Rockstar Games\<title>, value InstallFolder
//                            (InstallFolderSteam / InstallFolderEpic when bought there)
//   EA app / Origin          HKLM\SOFTWARE\WOW6432Node\EA Games\<title>, value "Install Dir";
//                            %ProgramData%\Origin\LocalContent\<title>\*.mfst, `dipinstallpath`
//   Battle.net               uninstall entries published by Blizzard Entertainment, InstallLocation
//   Xbox app / Microsoft Store  <drive>:\XboxGames\<title>\Content\MicrosoftGame.config, and a
//                            package folder holding MicrosoftGame.config
//   Windows' own hint        HKCU\System\GameConfigStore\Children\*, value MatchedExeFullPath
//                            (what Game Bar matched as a game)
// See docs/launcher-game-detection.md for the sources.

/** A game found by a store with no launch link: its name, folder and the store's id. */
export interface GameFolder {
    readonly name: string;
    readonly folder: string;
    readonly store: string;
}

/** The name a registry key is listed by: its last path segment. */
function lastSegment(key: string): string {
    return key.slice(key.lastIndexOf("\\") + 1);
}

/** A folder from a registry value: backslashes, no trailing separator, or null when unusable. */
function folderValue(value: string | undefined): string | null {
    const dir = value?.replace(/\//g, "\\").replace(/\\+$/, "");
    return dir && folder.safeParse(dir).success ? dir : null;
}

function storeId(store: string, name: string): string {
    return `${store}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Keys that sit beside Rockstar's games without being one. */
const ROCKSTAR_NOT_GAMES = /^(rockstar games|launcher|social club|rockstar games social club|rockstar games launcher)$/i;

/** Rockstar's titles from `reg query ... /s` of its key. */
export function rockstarFolders(keys: readonly RegistryKey[]): GameFolder[] {
    const out: GameFolder[] = [];
    for (const found of keys) {
        const name = lastSegment(found.key);
        if (!name || ROCKSTAR_NOT_GAMES.test(name)) continue;
        for (const value of ["installfolder", "installfolderepic", "installfoldersteam"]) {
            const dir = folderValue(found.values.get(value));
            if (dir) out.push({ name, folder: dir, store: storeId("rockstar", name) });
        }
    }
    return out;
}

/** EA's games from `reg query` of its `EA Games` key. */
export function eaFolders(keys: readonly RegistryKey[]): GameFolder[] {
    const out: GameFolder[] = [];
    for (const found of keys) {
        const name = lastSegment(found.key);
        const dir = folderValue(found.values.get("install dir"));
        if (name && !/^ea games$/i.test(name) && dir) out.push({ name, folder: dir, store: storeId("ea", name) });
    }
    return out;
}

/** The install folder an Origin `.mfst` names: `dipinstallpath`, URL-encoded. */
export function originInstallPath(text: string): string | null {
    const raw = /(?:^|[&?])dipinstallpath=([^&\s]+)/i.exec(text)?.[1];
    if (!raw) return null;
    try {
        return folderValue(decodeURIComponent(raw));
    } catch {
        return null;
    }
}

/** Battle.net's games out of the uninstall entries: Blizzard's, bar its own client. */
export function battleNetFolders(keys: readonly RegistryKey[]): GameFolder[] {
    const out: GameFolder[] = [];
    for (const found of keys) {
        const publisher = found.values.get("publisher") ?? "";
        const name = found.values.get("displayname") ?? "";
        const dir = folderValue(found.values.get("installlocation"));
        if (!/^Blizzard Entertainment/i.test(publisher) || !name || /^battle\.net/i.test(name) || !dir) continue;
        out.push({ name, folder: dir, store: storeId("battlenet", name) });
    }
    return out;
}

/** Windows' Game Bar matches: the folder of each `MatchedExeFullPath`, never a system one. */
export function gameConfigFolders(keys: readonly RegistryKey[], windowsDir: string): GameFolder[] {
    const out: GameFolder[] = [];
    for (const found of keys) {
        const exe = found.values.get("matchedexefullpath");
        if (!exe || !/\.exe$/i.test(exe) || !folder.safeParse(exe).success) continue;
        const dir = win32.dirname(exe);
        if (dir.toLowerCase().startsWith(windowsDir.toLowerCase())) continue;
        out.push({ name: basename(dir), folder: dir, store: "windows:gamebar" });
    }
    return out;
}

/** The drives' `XboxGames\<title>\Content` folders that hold a `MicrosoftGame.config`. */
export async function xboxFolders(drives = "CDEFGHIJKLMNOPQRSTUVWXYZ"): Promise<GameFolder[]> {
    const out: GameFolder[] = [];
    for (const letter of drives) {
        const root = `${letter}:\\XboxGames`;
        for (const title of (await readdir(root).catch(() => [] as string[])).slice(0, MAX_PER_STORE)) {
            const content = join(root, title, "Content");
            if (await exists(join(content, "MicrosoftGame.config"))) out.push({ name: title, folder: content, store: storeId("xbox", title) });
        }
    }
    return out;
}

/** The folders Origin's `LocalContent` manifests name. */
export async function originFolders(programData: string): Promise<GameFolder[]> {
    const root = join(programData, "Origin", "LocalContent");
    const out: GameFolder[] = [];
    for (const title of (await readdir(root).catch(() => [] as string[])).slice(0, MAX_PER_STORE)) {
        for (const file of (await readdir(join(root, title)).catch(() => [] as string[])).filter((name) => /\.mfst$/i.test(name)).slice(0, 4)) {
            const dir = originInstallPath((await readBounded(join(root, title, file))) ?? "");
            if (dir) out.push({ name: title, folder: dir, store: storeId("ea", title) });
        }
    }
    return out;
}

/**
 * The EA app's installed games: a folder per title in
 * `%ProgramData%\EA Desktop\InstallData`, whose game is in `EA Games\<title>`
 * under a library folder (its default is `Program Files\EA Games`). Only a
 * title whose folder is found on a drive is listed.
 */
export async function eaAppFolders(programData: string, drives = "CDEFGHIJKLMNOPQRSTUVWXYZ"): Promise<GameFolder[]> {
    const out: GameFolder[] = [];
    const titles = (await readdir(join(programData, "EA Desktop", "InstallData")).catch(() => [] as string[])).filter((title) => title && !/^(base-|\.)/i.test(title)).slice(0, MAX_PER_STORE);
    for (const title of titles) {
        for (const letter of drives) {
            const dir = (await Promise.all([`${letter}:\Program Files\EA Games\${title}`, `${letter}:\EA Games\${title}`].map(async (path) => ((await exists(path)) ? path : null)))).find((path) => path !== null);
            if (dir) {
                out.push({ name: title, folder: dir, store: storeId("ea", title) });
                break;
            }
        }
    }
    return out;
}

/**
 * The folders of games these stores keep, read once per listing, each store
 * failing on its own. Windows only; every read is bounded and read-only.
 */
export async function gameFolders(env: NodeJS.ProcessEnv = process.env): Promise<GameFolder[]> {
    const wow = "HKLM\\SOFTWARE\\WOW6432Node";
    const windowsDir = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const lists = await Promise.all([
        registry([`${wow}\\Rockstar Games`, "/s"]).then(rockstarFolders),
        registry([`${wow}\\EA Games`, "/s"]).then(eaFolders),
        originFolders(env.ProgramData ?? "C:\\ProgramData"),
        eaAppFolders(env.ProgramData ?? "C:\\ProgramData"),
        Promise.all(UNINSTALL_HIVES.map((hive) => registry([hive, "/s", "/f", "Blizzard Entertainment", "/d", "/e"]))).then((hives) => battleNetFolders(hives.flat())),
        xboxFolders(),
        registry(["HKCU\\System\\GameConfigStore\\Children", "/s"]).then((keys) => gameConfigFolders(keys, windowsDir))
    ].map((list) => list.catch(() => [] as GameFolder[])));
    return lists.flat().slice(0, MAX_PER_STORE * 2);
}
/** Every store above, each failing on its own: one unreadable store never hides the others. */
export async function storeApps(env: NodeJS.ProcessEnv = process.env): Promise<StoreApp[]> {
    const lists = await Promise.all([
        packagedApps(),
        epicGames(env.ProgramData ?? "C:\\ProgramData"),
        steamGames(env["ProgramFiles(x86)"]),
        gogGames(),
        ubisoftGames()
    ].map((list) => list.catch(() => [] as StoreApp[])));
    return lists.flat();
}
