/**
 * What an uploaded archive is, and what of it reaches a server.
 *
 * Pure: it reads entry names and the text of a few small files, and decides.
 *
 * A server pack is whatever a modpack's site hands out as "server files": the
 * mods and configs, usually inside one folder named after the pack, next to a
 * start script, an installer, a `server.jar` and sometimes a world. The image
 * installs the loader itself and writes its own settings, so only the content is
 * kept: the folder is taken off, and everything that would start a second
 * server, overwrite Polaris's settings or replace the world is left out.
 *
 * A world is a folder with a `level.dat` in it, at any depth; that folder and
 * nothing else is kept.
 */

import type { ZipEntry } from "./zip";

/** The loaders a pack can name, as the image's `TYPE` spells them. */
export type PackLoader = "FORGE" | "NEOFORGE" | "FABRIC" | "QUILT";

export interface DetectedLoader {
    readonly type: PackLoader;
    /** The Minecraft release, or null when the pack does not say. */
    readonly minecraft: string | null;
    /** The loader's own version, or null to let the image pick the newest. */
    readonly version: string | null;
}

export type ArchiveKind = "pack" | "world";

/** Why an archive is not what was asked for, as a code the screen words. */
export type PlanFailure = "empty" | "noContent" | "isWorld" | "isPack" | "ambiguous";

export interface Plan {
    readonly kind: ArchiveKind;
    /** The folder inside the archive that was taken off, "" when none. */
    readonly root: string;
    /** Each kept entry's source name and the name it is stored under. */
    readonly kept: readonly { readonly from: string; readonly to: string }[];
    /** Top-level names that were left out, for the screen to list. */
    readonly dropped: readonly string[];
    /** Jars in `mods/`. */
    readonly mods: number;
    /** Jars in `plugins/`. */
    readonly plugins: number;
    /** For a world: the name of its folder in the archive. */
    readonly levelName: string | null;
    /** For a world: datapacks it carries. */
    readonly datapacks: number;
}

export class PlanRefusal extends Error {
    constructor(readonly reason: PlanFailure) {
        super(`archive refused: ${reason}`);
    }
}

const CONTENT_DIRS = new Set(["mods", "config", "plugins"]);
/** How deep the content may sit: the image looks this far, and so does this. */
const MAX_DEPTH = 3;

/** Top-level files a server pack carries for starting a server by hand, or that
 *  hold what Polaris manages itself: the access lists, the settings, the icon. */
const DROPPED_FILES = new Set([
    "eula.txt",
    "server.properties",
    "user_jvm_args.txt",
    "server_starter.conf",
    "server-setup-config.yaml",
    "forge-auto-install.txt",
    "variables.txt",
    "variables.txt.example",
    "ops.json",
    "whitelist.json",
    "banned-ips.json",
    "banned-players.json",
    "usercache.json",
    "server-icon.png",
    "manifest.json",
    "modlist.html",
    "fabric-server-launcher.properties"
]);
const DROPPED_EXTENSIONS = [".jar", ".sh", ".bat", ".cmd", ".ps1", ".command", ".exe"];
/** Top-level folders the image makes or fills itself, and the ones that only
 *  ever hold what a previous server left behind. */
const DROPPED_DIRS = new Set([
    "libraries",
    "versions",
    ".fabric",
    ".quilt",
    "logs",
    "crash-reports",
    "backups",
    "packs",
    "cache",
    ".cache",
    "__macosx"
]);

function parts(name: string): string[] {
    return name.split("/").filter((part) => part.length > 0);
}

/** The entries that are files, with the folders they imply. */
function fileNames(entries: readonly ZipEntry[]): string[] {
    return entries.filter((entry) => !entry.directory).map((entry) => entry.name);
}

/** Folders that hold a `level.dat` directly: the worlds in the archive. */
function levelFolders(names: readonly string[]): string[] {
    const folders = new Set<string>();
    for (const name of names) {
        const split = parts(name);
        if (split[split.length - 1] === "level.dat") folders.add(split.slice(0, -1).join("/"));
    }
    return [...folders];
}

/** The folder a pack's content sits in, as the image finds it: the shallowest
 *  one holding `mods`, `config` or `plugins`. Null when there is none. */
function contentRoot(names: readonly string[]): string | null {
    let best: { depth: number; roots: Set<string> } | null = null;
    for (const name of names) {
        const split = parts(name);
        for (let depth = 0; depth < Math.min(split.length - 1, MAX_DEPTH); depth += 1) {
            if (!CONTENT_DIRS.has(split[depth]!.toLowerCase())) continue;
            const root = split.slice(0, depth).join("/");
            if (!best || depth < best.depth) best = { depth, roots: new Set([root]) };
            else if (depth === best.depth) best.roots.add(root);
            break;
        }
    }
    if (!best) return null;
    if (best.roots.size > 1) throw new PlanRefusal("ambiguous");
    return [...best.roots][0]!;
}

function under(name: string, root: string): string | null {
    if (root.length === 0) return name;
    return name.startsWith(`${root}/`) ? name.slice(root.length + 1) : null;
}

function droppedTop(relative: string, worlds: ReadonlySet<string>): boolean {
    const split = parts(relative);
    const top = split[0]!.toLowerCase();
    if (split.length === 1) {
        return (
            DROPPED_FILES.has(top) ||
            DROPPED_EXTENSIONS.some((extension) => top.endsWith(extension))
        );
    }
    return DROPPED_DIRS.has(top) || worlds.has(split[0]!);
}

/** What of a server pack reaches the server. */
export function planPack(entries: readonly ZipEntry[]): Plan {
    const names = fileNames(entries);
    if (names.length === 0) throw new PlanRefusal("empty");
    const root = contentRoot(names);
    if (root === null) {
        throw new PlanRefusal(levelFolders(names).length > 0 ? "isWorld" : "noContent");
    }
    // A world inside the pack's folder is the pack author's own save, and
    // copying it would replace the one being played on.
    const worlds = new Set(
        levelFolders(names)
            .map((folder) => under(folder, root))
            .filter((folder): folder is string => folder !== null && !folder.includes("/"))
    );
    const kept: { from: string; to: string }[] = [];
    const dropped = new Set<string>();
    let mods = 0;
    let plugins = 0;
    for (const name of names) {
        const relative = under(name, root);
        if (relative === null || relative.length === 0) continue;
        if (droppedTop(relative, worlds)) {
            dropped.add(parts(relative)[0]!);
            continue;
        }
        kept.push({ from: name, to: relative });
        if (/^mods\/[^/]+\.jar$/i.test(relative)) mods += 1;
        if (/^plugins\/[^/]+\.jar$/i.test(relative)) plugins += 1;
    }
    if (kept.length === 0) throw new PlanRefusal("noContent");
    return {
        kind: "pack",
        root,
        kept,
        dropped: [...dropped].sort(),
        mods,
        plugins,
        levelName: null,
        datapacks: 0
    };
}

/** A folder name the server can be pointed at. */
function levelNameOf(folder: string): string {
    const last = parts(folder).pop() ?? "";
    const cleaned = last.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return cleaned.length > 0 ? cleaned.slice(0, 48) : "world";
}

/** What of a world archive reaches the server: its one level folder. */
export function planWorld(entries: readonly ZipEntry[]): Plan {
    const names = fileNames(entries);
    if (names.length === 0) throw new PlanRefusal("empty");
    const folders = levelFolders(names).sort(
        (a, b) => parts(a).length - parts(b).length || a.localeCompare(b)
    );
    if (folders.length === 0) {
        throw new PlanRefusal(contentRoot(names) !== null ? "isPack" : "noContent");
    }
    const root = folders[0]!;
    // Two worlds side by side at the same depth: the archive is a server's whole
    // folder (world, world_nether, world_the_end) or a collection, and the main
    // one is the shortest name - `world` before `world_nether`.
    const kept: { from: string; to: string }[] = [];
    const dropped = new Set<string>();
    let datapacks = 0;
    for (const name of names) {
        const relative = under(name, root);
        if (relative === null || relative.length === 0) {
            dropped.add(parts(name)[0] ?? name);
            continue;
        }
        const top = parts(relative)[0]!.toLowerCase();
        // The lock the game holds while it plays; a copy of it refuses to open.
        if (relative === "session.lock") continue;
        if (top === "__macosx") continue;
        kept.push({ from: name, to: relative });
        if (/^datapacks\/[^/]+(\.zip|\/pack\.mcmeta)$/i.test(relative)) datapacks += 1;
    }
    return {
        kind: "world",
        root,
        kept,
        dropped: [...dropped].sort(),
        mods: 0,
        plugins: 0,
        levelName: levelNameOf(root || "world"),
        datapacks
    };
}

/** A version as it may go into a variable. Same shape `loader-pin.ts` takes. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const RELEASE = /^\d+\.\d+(\.\d+)?$/;
const MOVING = new Set(["latest", "recommended"]);

function release(value: string | undefined | null): string | null {
    const text = (value ?? "").trim();
    return RELEASE.test(text) ? text : null;
}

function loaderVersion(value: string | undefined | null): string | null {
    const text = (value ?? "").trim();
    if (text.length === 0 || MOVING.has(text.toLowerCase())) return null;
    return VERSION.test(text) ? text : null;
}

function loaderType(value: string | undefined | null): PackLoader | null {
    const text = (value ?? "").trim().toLowerCase();
    if (text === "forge") return "FORGE";
    if (text === "neoforge" || text === "neoforged") return "NEOFORGE";
    if (text === "fabric") return "FABRIC";
    if (text === "quilt") return "QUILT";
    return null;
}

/** `key=value` lines, as the start-script config files write them. */
export function properties(text: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
        const at = trimmed.search(/[=:]/);
        if (at <= 0) continue;
        const key = trimmed.slice(0, at).trim().toLowerCase();
        const value = trimmed
            .slice(at + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
        out.set(key, value);
    }
    return out;
}

/** NeoForge numbers itself after the release: 21.1.x is 1.21.1, 20.4.x is
 *  1.20.4. From 26 on its first two numbers are the release itself. */
function minecraftOfNeoForge(version: string): string | null {
    const match = /^(\d+)\.(\d+)\./.exec(version);
    if (!match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major >= 26) return `${major}.${minor}`;
    if (major < 20) return null;
    return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

/** The small files whose text says what the pack runs on, by base name. */
export const LOADER_FILES = new Set([
    "variables.txt",
    "forge-auto-install.txt",
    "manifest.json",
    "server-setup-config.yaml"
]);

function fromVariables(text: string): DetectedLoader | null {
    const vars = properties(text);
    const type = loaderType(vars.get("modloader"));
    if (!type) return null;
    return {
        type,
        minecraft: release(vars.get("minecraft_version")),
        version: loaderVersion(vars.get("modloader_version"))
    };
}

function fromAutoInstall(text: string): DetectedLoader | null {
    const vars = properties(text);
    const type = loaderType(vars.get("loadertype"));
    if (!type) return null;
    return {
        type,
        minecraft: release(vars.get("minecraftversion")),
        version: loaderVersion(vars.get("loaderversion"))
    };
}

function fromManifest(text: string): DetectedLoader | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const minecraft = (parsed as { minecraft?: unknown }).minecraft;
    if (typeof minecraft !== "object" || minecraft === null) return null;
    const game = release((minecraft as { version?: unknown }).version as string);
    const loaders = (minecraft as { modLoaders?: unknown }).modLoaders;
    if (!Array.isArray(loaders)) return null;
    const chosen =
        loaders.find((entry) => (entry as { primary?: unknown })?.primary === true) ?? loaders[0];
    const id = (chosen as { id?: unknown })?.id;
    if (typeof id !== "string") return null;
    const match = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(id.trim());
    if (!match) return null;
    const type = loaderType(match[1]);
    return type ? { type, minecraft: game, version: loaderVersion(match[2]) } : null;
}

function fromServerStarter(text: string): DetectedLoader | null {
    const minecraft = /^\s*mcVersion\s*:\s*["']?([^"'\s#]+)/m.exec(text)?.[1];
    const version = /^\s*loaderVersion\s*:\s*["']?([^"'\s#]+)/m.exec(text)?.[1];
    if (!minecraft && !version) return null;
    const installer = /^\s*installerUrl\s*:\s*["']?([^"'\s#]+)/m.exec(text)?.[1] ?? "";
    const type: PackLoader = /neoforged/i.test(installer)
        ? "NEOFORGE"
        : /fabricmc/i.test(installer)
          ? "FABRIC"
          : "FORGE";
    return { type, minecraft: release(minecraft), version: loaderVersion(version) };
}

/** What the file names alone give away: an installer, a launcher, or the
 *  libraries an earlier install left. */
function fromNames(names: readonly string[]): DetectedLoader | null {
    // Held in an object: the loop below fills it, which a plain variable's
    // narrowing does not see.
    const seen: { fabric: { minecraft: string | null; version: string | null } | null } = {
        fabric: null
    };
    let minecraft: string | null = null;
    for (const name of names) {
        const base = name.split("/").pop() ?? "";
        let match = /^neoforge-(\d+\.\d+\.\d+[A-Za-z0-9.+_-]*?)-(installer|universal|server)\.jar$/i.exec(
            base
        );
        if (match) {
            const version = loaderVersion(match[1]);
            if (version) return { type: "NEOFORGE", minecraft: minecraftOfNeoForge(version), version };
        }
        match = /^forge-(\d+\.\d+(?:\.\d+)?)-(\d+\.\d+\.\d+[A-Za-z0-9.+_-]*?)(?:-(installer|universal|server|shim))?\.jar$/i.exec(
            base
        );
        if (match) return { type: "FORGE", minecraft: release(match[1]), version: loaderVersion(match[2]) };
        match = /(?:^|\/)libraries\/net\/neoforged\/neoforge\/([^/]+)\//.exec(name);
        if (match) {
            const version = loaderVersion(match[1]);
            if (version) return { type: "NEOFORGE", minecraft: minecraftOfNeoForge(version), version };
        }
        match = /(?:^|\/)libraries\/net\/minecraftforge\/forge\/(\d+\.\d+(?:\.\d+)?)-([^/]+)\//.exec(name);
        if (match) return { type: "FORGE", minecraft: release(match[1]), version: loaderVersion(match[2]) };
        match = /^fabric-server-mc\.(\d+\.\d+(?:\.\d+)?)-loader\.([^-]+)-launcher\.[^/]+\.jar$/i.exec(base);
        if (match) return { type: "FABRIC", minecraft: release(match[1]), version: loaderVersion(match[2]) };
        match = /(?:^|\/)libraries\/net\/fabricmc\/fabric-loader\/([^/]+)\//.exec(name);
        if (match) seen.fabric = { minecraft: seen.fabric?.minecraft ?? null, version: loaderVersion(match[1]) };
        match = /(?:^|\/)libraries\/net\/fabricmc\/intermediary\/([^/]+)\//.exec(name);
        if (match) seen.fabric = { minecraft: release(match[1]), version: seen.fabric?.version ?? null };
        match = /(?:^|\/)libraries\/org\/quiltmc\/quilt-loader\/([^/]+)\//.exec(name);
        if (match) return { type: "QUILT", minecraft, version: loaderVersion(match[1]) };
        match = /(?:^|\/)(?:libraries\/net\/minecraft\/server|versions)\/(\d+\.\d+(?:\.\d+)?)\//.exec(name);
        if (match) minecraft = release(match[1]);
    }
    if (seen.fabric) return { type: "FABRIC", minecraft: seen.fabric.minecraft ?? minecraft, version: seen.fabric.version };
    return null;
}

/**
 * The loader and releases a pack runs on, from the files that say so - the
 * start-script configs first, then the CurseForge manifest, then the names of
 * the installer or the libraries. Each source may answer only part of it, and a
 * later one fills what an earlier one left out, for the same loader only.
 * Null when nothing in the pack names a loader.
 */
export function detectLoader(
    texts: ReadonlyMap<string, string>,
    names: readonly string[]
): DetectedLoader | null {
    const readers: [string, (text: string) => DetectedLoader | null][] = [
        ["variables.txt", fromVariables],
        ["forge-auto-install.txt", fromAutoInstall],
        ["manifest.json", fromManifest],
        ["server-setup-config.yaml", fromServerStarter]
    ];
    const found: DetectedLoader[] = [];
    for (const [file, read] of readers) {
        const text = texts.get(file);
        const answer = text ? read(text) : null;
        if (answer) found.push(answer);
    }
    const named = fromNames(names);
    if (named) found.push(named);
    const first = found[0];
    if (!first) return null;
    let minecraft = first.minecraft;
    let version = first.version;
    for (const other of found.slice(1)) {
        if (other.type !== first.type) continue;
        minecraft ??= other.minecraft;
        version ??= other.version;
    }
    if (first.type === "NEOFORGE" && minecraft === null && version)
        minecraft = minecraftOfNeoForge(version);
    return { type: first.type, minecraft, version };
}

/** The entries whose text `detectLoader` reads: the loader files at the pack's
 *  own top level, never one buried in a mod's config folder. */
export function loaderFileEntries(
    entries: readonly ZipEntry[],
    root: string
): Map<string, ZipEntry> {
    const out = new Map<string, ZipEntry>();
    for (const entry of entries) {
        if (entry.directory) continue;
        const relative = under(entry.name, root);
        if (relative === null || relative.includes("/")) continue;
        const base = relative.toLowerCase();
        if (LOADER_FILES.has(base) && !out.has(base)) out.set(base, entry);
    }
    return out;
}
