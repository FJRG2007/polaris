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
 */

import { z } from "zod";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, sep } from "node:path";

/** How a listed program is started. */
export type AppLaunch =
    /** Handed to the shell as a double-click would: a Start menu shortcut, a macOS bundle. */
    | { readonly kind: "open"; readonly path: string; }
    /** A store's own launch link, from `isVettedLaunchUri`. */
    | { readonly kind: "uri"; readonly uri: string; }
    /** A packaged (Store, Xbox) app, by its AppUserModelID. */
    | { readonly kind: "packaged"; readonly id: string; }
    /** An executable inside a game's own folder, started there with no arguments. */
    | { readonly kind: "exe"; readonly path: string; readonly cwd: string; };

export interface StoreApp {
    readonly label: string;
    /** Unique per program, also the key the launcher's rows are opened by. */
    readonly path: string;
    readonly launch: AppLaunch;
    /** A file to take the row's picture from: an executable, or an image the store keeps. */
    readonly icon?: string;
    /** The game's own install folder, so a program running from inside it is known as this game. */
    readonly folder?: string;
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

async function registry(args: readonly string[]): Promise<RegistryKey[]> {
    const output = await run("reg.exe", ["query", ...args]);
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

const startAppSchema = z.object({ Name: label, AppID: z.string().regex(AUMID) });
const startAppsSchema = z.union([z.array(z.unknown()).max(5000), z.unknown()]);

/**
 * The packaged apps the Start menu lists (Store, Xbox and Game Pass games),
 * from `Get-StartApps`: the same list Start shows, with the AppUserModelID
 * that opens each. Desktop programs in it are left out - their shortcuts are
 * already read from the Start menu's folders.
 */
export async function packagedApps(): Promise<StoreApp[]> {
    const script = "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name,AppID | ConvertTo-Json -Compress";
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
        out.push({ label: app.data.Name, path: `packaged:${app.data.AppID}`, launch: { kind: "packaged", id: app.data.AppID } });
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
    TechnicalType: z.string().max(200).optional()
});

/**
 * The Epic Games Launcher's installed games: one `.item` JSON per install in
 * `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests`, launched with the
 * launcher's own link (Playnite's `EpicLauncher.GameLaunchUrlMask`). Add-ons
 * that cannot be launched and engine plugins are left out, as Playnite does.
 */
export async function epicGames(programData: string): Promise<StoreApp[]> {
    const dir = join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => /\.item$/i.test(name)).slice(0, MAX_PER_STORE);
    const out: StoreApp[] = [];
    for (const name of names) {
        const manifest = await readJson(join(dir, name), epicManifestSchema);
        if (!manifest || manifest.bIsIncompleteInstall) continue;
        const categories = manifest.AppCategories ?? [];
        if (categories.includes("addons") && !categories.includes("addons/launchable")) continue;
        if (categories.some((category) => category === "plugins" || category === "plugins/engine")) continue;
        if (manifest.TechnicalType?.includes("plugins/engine")) continue;
        if (!(await exists(manifest.InstallLocation))) continue;
        const exe = manifest.LaunchExecutable && /\.exe$/i.test(manifest.LaunchExecutable) ? inside(manifest.InstallLocation, manifest.LaunchExecutable) : null;
        const uri = `com.epicgames.launcher://apps/${manifest.CatalogNamespace}%3A${manifest.CatalogItemId}%3A${manifest.AppName}?action=launch&silent=true`;
        out.push({
            label: manifest.DisplayName ?? basename(manifest.InstallLocation),
            path: `epic:${manifest.AppName}`,
            launch: { kind: "uri", uri },
            ...(exe ? { icon: exe } : {}),
            // An engine (`UE_5.3`) is not a game somebody is playing.
            ...(/^UE_/i.test(manifest.AppName) ? {} : { folder: manifest.InstallLocation })
        });
    }
    return out;
}

// --- Steam -------------------------------------------------------------------

/** Steam's own tools, which its library lists beside the games. */
const STEAM_TOOLS = new Set(["228980", "1070560", "1391110", "1628350", "1493710", "2180100"]);

async function steamRoots(programFilesX86: string | undefined): Promise<string[]> {
    const roots: string[] = [];
    const [key] = await registry(["HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]);
    const fromRegistry = key?.values.get("steampath");
    if (fromRegistry) roots.push(normalize(fromRegistry));
    if (programFilesX86) roots.push(join(programFilesX86, "Steam"));
    return roots.filter((root, at) => roots.findIndex((other) => other.toLowerCase() === root.toLowerCase()) === at);
}

/**
 * Steam's installed games: every library folder `steamapps\libraryfolders.vdf`
 * lists, and an `appmanifest_<id>.acf` per game in each, launched with
 * `steam://rungameid/<id>` (Playnite's `SteamLibrary`). A game still
 * downloading is left out until its manifest says it is fully installed.
 */
export async function steamGames(programFilesX86: string | undefined): Promise<StoreApp[]> {
    const out: StoreApp[] = [];
    const seen = new Set<string>();
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
                if (!Number.isFinite(flags) || (flags & 4) === 0) continue;
                if (/^(Steamworks|Steam Linux Runtime|Proton )/i.test(title.data)) continue;
                seen.add(id);
                const icon = join(root, "appcache", "librarycache", `${id}_icon.jpg`);
                const installdir = vdfGet(state, "installdir");
                const home = typeof installdir === "string" ? inside(join(apps, "common"), installdir) : null;
                out.push({
                    label: title.data,
                    path: `steam:${id}`,
                    launch: { kind: "uri", uri: `steam://rungameid/${id}` },
                    ...((await exists(icon)) ? { icon } : {}),
                    ...(home ? { folder: home } : {})
                });
            }
        }
    }
    return out;
}

// --- GOG ---------------------------------------------------------------------

const gogInfoSchema = z.object({
    name: label.optional(),
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
 * when it is an executable inside that folder that takes no arguments.
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
        const task = info?.playTasks?.find((candidate) => candidate.isPrimary);
        if (!task || (task.type && task.type !== "FileTask") || task.arguments?.trim() || !task.path || !/\.exe$/i.test(task.path)) continue;
        const exe = inside(dir, task.path);
        const cwd = task.workingDir ? inside(dir, task.workingDir) : dir;
        if (!exe || !cwd) continue;
        const title = info?.name ?? entry?.values.get("displayname");
        if (!title) continue;
        out.push({ label: title, path: `gog:${id}`, launch: { kind: "exe", path: exe, cwd }, icon: exe, folder: dir });
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
            out.push({ label: basename(dir), path: `ubisoft:${id}`, launch: { kind: "uri", uri: `uplay://launch/${id}` }, folder: dir });
            if (out.length >= MAX_PER_STORE) return out;
        }
    }
    return out;
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
