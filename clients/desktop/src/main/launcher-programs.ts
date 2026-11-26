/**
 * The Windows programs that have no Start menu shortcut, and the other names
 * every program answers to - the two reasons a launcher misses what somebody
 * types. Read the way PowerToys and Vicinae read them (`Win32Program.cs`,
 * `win-app-database.cpp`): the Desktop folders, `App Paths` and the
 * registry's uninstall entries. The uninstall entries are what finds a game a
 * launcher of its own installed without a shortcut (Rockstar's Grand Theft
 * Auto V, EA app, Battle.net, Riot) with no adapter per store; Rockstar and
 * Battle.net games are then started through their own launcher, the way
 * Playnite's `RockstarGamesLibrary` and `BattleNetLibrary` (MIT) start them.
 *
 * The readers are pure over `reg query` text and an injected file system, so
 * the tests feed them fixtures; nothing here reads the registry by itself
 * except `readHives`, and nothing is run through a shell.
 */

import { win32 } from "node:path";
import { parseRegQuery, type AppLaunch, type RegistryKey } from "./launcher-stores";

const { basename, dirname, join, normalize } = win32;

/** One program found, before the sources are merged. */
export interface FoundProgram {
    readonly label: string;
    /** Unique per program, the key its row is opened by. */
    readonly path: string;
    readonly launch?: AppLaunch;
    readonly icon?: string;
    /** What it starts, when known - an executable, a launch link: what two sources are compared by. */
    readonly target?: string;
    /** Other names it is found by. */
    readonly aliases?: readonly string[];
}

/** What the readers ask of the file system. */
export interface ProgramFiles {
    /** Whether this file is there. */
    readonly exists: (path: string) => Promise<boolean>;
    /** The `.exe` files directly inside a folder, as full paths; empty when it cannot be read. */
    readonly exes: (folder: string) => Promise<readonly string[]>;
    /** An executable's `FileDescription`, or null (`launcher-exe-info.ts`). */
    readonly describe: (exe: string) => Promise<string | null>;
}

export const UNINSTALL_HIVES = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
] as const;

export const APP_PATHS_HIVES = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths"
] as const;

/** The most programs one source may add, so an odd registry cannot fill memory. */
const MAX_PER_SOURCE = 2000;
/** The most executables looked at in one install folder when its entry names none. */
const MAX_FOLDER_EXES = 40;

/**
 * Entries that are not a program somebody opens: updates, runtimes, drivers,
 * redistributables and the like, by the words their installers name them with.
 */
const NOT_AN_APP = /\b(update|hotfix|security update|service pack|redistributable|runtime|run-time|sdk|driver|drivers|framework|targeting pack|language pack|help ?pack|helper|bootstrapper|prerequisites?|vc\+\+|visual c\+\+|directx|(?<!\w)\.net|webview2|uninstall\w*|setup|installer)\b/i;

/** An executable that only installs, updates or removes its program. */
const NOT_A_LAUNCHER = /(^|\\)(unins\w*|uninst\w*|uninstall\w*|setup\w*|install\w*|update\w*|updater\w*|maintenancetool|crashreport\w*|crashpad\w*|crashhandler\w*|helper\w*|elevate\w*|vc_redist\w*)\.exe$/i;

/**
 * Battle.net's games by the `--uid` their uninstall entry carries and the
 * product code `Battle.net.exe --exec="launch <code>"` takes, from Playnite's
 * `BattleNetGames.cs` (MIT). Classic games without a code start by their exe.
 */
const BATTLE_NET_PRODUCTS: Readonly<Record<string, string>> = {
    wow: "WoW", diablo3: "D3", s2: "S2", s1: "S1", hs_beta: "WTCG", heroes: "Hero", prometheus: "Pro", viper: "VIPR", odin: "ODIN",
    w3: "W3", lazarus: "LAZR", zeus: "ZEUS", wlby: "WLBY", osi: "OSI", rtro: "RTRO", fore: "FORE", anbs: "ANBS", auks: "AUKS", fen: "Fen",
    d1: "D1", w1r: "W1R", w2r: "W2R", w1: "W1", w2: "W2", gryphon: "GRY", aris: "ARIS", scorpio: "SCOR", arkansas: "ARK", libra: "LBRA",
    pinta: "PNTA", aqua: "AQUA"
};

/** A registry path value: quotes and an icon index (",0") taken off, `%Var%` expanded. */
export function registryPath(value: string | undefined, env: NodeJS.ProcessEnv): string | null {
    if (!value) return null;
    let path = value.trim();
    const quoted = /^"([^"]+)"/.exec(path);
    if (quoted?.[1]) path = quoted[1];
    else path = path.replace(/,\s*-?\d+$/, "");
    path = path.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? env[name.toUpperCase()] ?? whole);
    if (path.includes("%") || !/^[A-Za-z]:\\/.test(path) || path.length > 1000) return null;
    return normalize(path);
}

/** Whether `path` lies inside `folder`. */
function within(path: string, folder: string): boolean {
    const base = `${normalize(folder).replace(/[\\/]+$/, "").toLowerCase()}\\`;
    return normalize(path).toLowerCase().startsWith(base);
}

/** A packaged app's folder: its executables start only through the app's own identity. */
function isPackagedFolder(path: string): boolean {
    return /\\WindowsApps\\/i.test(path);
}

/**
 * The names an executable answers to: its file name, and that name without a
 * "Play" in front or a version behind - "PlayGTAV.exe" is also "GTAV",
 * "Discord.exe" "Discord", "javaw.exe" nothing more.
 */
export function exeAliases(exe: string): string[] {
    const name = basename(exe).replace(/\.exe$/i, "");
    const bare = name.replace(/^[Pp]lay(?=[A-Z0-9_-])/, "").replace(/[\s_-]*v?\d+(?:\.\d+)*$/i, "");
    return [...new Set([name, bare].filter((alias) => alias.length >= 2))];
}

/** The words of a name, folded, for comparing it with a file name. */
function words(text: string): string[] {
    return text
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/**
 * The executable an install folder most plausibly opens its program with,
 * when the entry names none (PowerToys' `UninstallRegistryAppLocator`): the
 * one executable that is not an installer or helper, or else the one whose
 * name is the program's name, its initials, or one of its words.
 */
export function plausibleExe(label: string, exes: readonly string[]): string | null {
    const candidates = exes.filter((exe) => /\.exe$/i.test(exe) && !NOT_A_LAUNCHER.test(exe)).slice(0, MAX_FOLDER_EXES);
    if (candidates.length === 1) return candidates[0]!;
    const labelWords = words(label);
    const joined = labelWords.join("");
    const initials = labelWords.map((word) => word[0]).join("");
    const stem = (exe: string) => words(basename(exe).replace(/\.exe$/i, "")).join("");
    return (
        candidates.find((exe) => stem(exe) === joined) ??
        candidates.find((exe) => initials.length >= 2 && stem(exe).startsWith(initials)) ??
        candidates.find((exe) => labelWords.some((word) => word.length >= 3 && stem(exe) === word)) ??
        null
    );
}

/** The executable of the uninstall entry named `name`, inside its `InstallLocation`. */
function launcherIn(keys: readonly RegistryKey[], name: RegExp, exe: string, env: NodeJS.ProcessEnv): string | null {
    const key = keys.find((candidate) => name.test(candidate.values.get("displayname")?.trim() ?? ""));
    const folder = registryPath(key?.values.get("installlocation")?.replace(/^"|"$/g, ""), env);
    return folder ? join(folder, exe) : null;
}

/**
 * How a store's own launcher starts the game an uninstall entry names, or
 * null for a game started by its own executable. Rockstar: the entry's
 * `UninstallString` runs the launcher with `-uninstall=<title>`, and play is
 * `Launcher.exe -launchTitleInFolder <folder>`. Battle.net: `--uid=<id>`, and
 * play is `Battle.net.exe --exec="launch <product>"`. Only a launcher still on
 * disk is used; the arguments come from the registry, never typed text.
 */
async function storeLaunch(
    key: RegistryKey,
    keys: readonly RegistryKey[],
    location: string | null,
    files: ProgramFiles,
    env: NodeJS.ProcessEnv
): Promise<AppLaunch | null> {
    const uninstall = key.values.get("uninstallstring") ?? "";
    if (location && /(?:launcher|uninstall)\.exe"?\s.*-uninstall=\S+/i.test(uninstall)) {
        const launcher = launcherIn(keys, /^Rockstar Games Launcher$/i, "Launcher.exe", env);
        if (launcher && (await files.exists(launcher))) return { kind: "exe", path: launcher, cwd: dirname(launcher), args: ["-launchTitleInFolder", location] };
    }
    const uid = /battle\.net.*--uid=([a-z0-9_]+)/i.exec(uninstall)?.[1]?.toLowerCase();
    const product = uid ? (BATTLE_NET_PRODUCTS[uid] ?? BATTLE_NET_PRODUCTS[uid.replace(/_[a-z]{4}$/, "")]) : undefined;
    if (product) {
        const launcher = launcherIn(keys, /^Battle\.net$/i, "Battle.net.exe", env)
            ?? (env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "Battle.net", "Battle.net.exe") : null);
        if (launcher && (await files.exists(launcher))) return { kind: "exe", path: launcher, cwd: dirname(launcher), args: [`--exec=launch ${product}`] };
    }
    return null;
}

/**
 * The uninstall entries that are programs to open: a name, not a system
 * component or an update of another entry, and an executable to start - its
 * `DisplayIcon` when that is an `.exe` inside its `InstallLocation` (or, with
 * no location given, anywhere) and not an uninstaller or updater, else the
 * folder's plausible main executable. A Rockstar or Battle.net game starts
 * through its store's launcher.
 */
export async function uninstallPrograms(keys: readonly RegistryKey[], files: ProgramFiles, env: NodeJS.ProcessEnv): Promise<FoundProgram[]> {
    const out: FoundProgram[] = [];
    for (const key of keys) {
        if (out.length >= MAX_PER_SOURCE) break;
        const values = key.values;
        const label = values.get("displayname")?.trim();
        if (!label || label.length > 300 || NOT_AN_APP.test(label)) continue;
        if (/^0x0*1$/i.test(values.get("systemcomponent") ?? "")) continue;
        if (values.get("parentkeyname") || /update|hotfix/i.test(values.get("releasetype") ?? "")) continue;
        const location = registryPath(values.get("installlocation")?.replace(/^"|"$/g, ""), env);
        if (location && isPackagedFolder(location)) continue;
        let exe = registryPath(values.get("displayicon"), env);
        if (!exe || !/\.exe$/i.test(exe) || NOT_A_LAUNCHER.test(exe) || (location && !within(exe, location)) || !(await files.exists(exe))) {
            exe = location ? plausibleExe(label, await files.exes(location)) : null;
        }
        if (!exe) continue;
        const launch = (await storeLaunch(key, keys, location, files, env)) ?? { kind: "exe", path: exe, cwd: dirname(exe) };
        out.push({
            label,
            path: `program:${exe.toLowerCase()}`,
            launch,
            icon: exe,
            target: exe,
            aliases: [...exeAliases(exe), ...(location ? [basename(location)] : [])]
        });
    }
    return out;
}

/**
 * `App Paths`: each key an executable's file name, its default value where it
 * is. Listed only for what somebody installed: never the Windows folder's or
 * a packaged app's, and only an executable with a `FileDescription` -
 * nameless executables are almost always helper binaries (Vicinae). Named by
 * that description when it is short, else by the file name.
 */
export async function appPathPrograms(keys: readonly RegistryKey[], files: ProgramFiles, env: NodeJS.ProcessEnv): Promise<FoundProgram[]> {
    const out: FoundProgram[] = [];
    const windows = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    for (const key of keys) {
        if (out.length >= MAX_PER_SOURCE) break;
        const name = /\\App Paths\\([^\\]+\.exe)$/i.exec(key.key)?.[1];
        // `reg` names the default value in the system's language: "(Default)", "(Predeterminado)".
        const fallback = [...key.values.entries()].find(([value]) => /^\(.+\)$/.test(value))?.[1];
        const exe = registryPath(key.values.get("(default)") ?? fallback, env);
        if (!name || !exe || !/\.exe$/i.test(exe) || NOT_A_LAUNCHER.test(exe) || within(exe, windows) || isPackagedFolder(exe)) continue;
        if (!(await files.exists(exe))) continue;
        const description = (await files.describe(exe))?.trim();
        if (!description) continue;
        const stems = [...new Set([...exeAliases(name), ...exeAliases(exe)])];
        const label = description.length <= 40 ? description : (stems[0] ?? name);
        out.push({
            label,
            path: `program:${exe.toLowerCase()}`,
            launch: { kind: "exe", path: exe, cwd: dirname(exe) },
            icon: exe,
            target: exe,
            aliases: [...new Set([...stems, description])]
        });
    }
    return out;
}

/** The address an Internet shortcut (`.url`) opens - `steam://rungameid/570` - or null. */
export function urlShortcutTarget(text: string): string | null {
    const url = /^\s*URL\s*=\s*(\S[^\r\n]*)$/im.exec(text.slice(0, 64 * 1024))?.[1]?.trim();
    return url && url.length <= 2000 ? url : null;
}

/** What a program starts, for telling two copies apart: its target, else its launch. */
function startsWhat(program: FoundProgram): string | undefined {
    if (program.target) return program.target.toLowerCase();
    const launch = program.launch;
    if (!launch) return undefined;
    if (launch.kind === "uri") return launch.uri.toLowerCase();
    if (launch.kind === "packaged") return `packaged:${launch.id.toLowerCase()}`;
    if (launch.kind === "exe") return launch.path.toLowerCase();
    return undefined;
}

/**
 * Every source as one list, best source first: a program two of them list is
 * kept once, as the first one listed it, with the other names of every copy
 * and the first picture any of them has.
 * Two copies are one program when they start the same thing - executable,
 * launch link, packaged app - or carry the same name.
 */
export function mergePrograms<T extends FoundProgram>(sources: readonly (readonly T[])[], limit: number): T[] {
    const kept: { program: T; aliases: Set<string>; }[] = [];
    const byTarget = new Map<string, number>();
    const byLabel = new Map<string, number>();
    for (const source of sources) {
        for (const program of source) {
            const target = startsWhat(program);
            const label = program.label.toLowerCase();
            const at = (target === undefined ? undefined : byTarget.get(target)) ?? byLabel.get(label);
            if (at !== undefined) {
                const entry = kept[at]!;
                // The copy kept is the best source to open it by, not always
                // the one with a picture: a Steam game's Start menu `.url`
                // has none, its store row has the game's icon.
                if (!entry.program.icon && program.icon) entry.program = { ...entry.program, icon: program.icon };
                for (const alias of [program.label, ...(program.aliases ?? [])]) entry.aliases.add(alias);
                if (target && !byTarget.has(target)) byTarget.set(target, at);
                continue;
            }
            if (kept.length >= limit) continue;
            const index = kept.length;
            kept.push({ program, aliases: new Set(program.aliases ?? []) });
            if (target) byTarget.set(target, index);
            byLabel.set(label, index);
        }
    }
    return kept.map(({ program, aliases }) => {
        const own = program.label.toLowerCase();
        return { ...program, aliases: [...aliases].filter((alias) => alias.toLowerCase() !== own).slice(0, 12) };
    });
}

/**
 * The Desktop folders a shortcut on the desktop sits in, each once: this
 * user's as Windows knows it (`app.getPath("desktop")`, which follows OneDrive
 * moving it), else the profile's, and everyone's.
 */
export function desktopFolders(userDesktop: string | undefined, env: NodeJS.ProcessEnv): string[] {
    const folders = [userDesktop || (env.USERPROFILE ? join(env.USERPROFILE, "Desktop") : undefined), env.PUBLIC ? join(env.PUBLIC, "Desktop") : undefined]
        .filter((dir): dir is string => Boolean(dir));
    return folders.filter((dir, index) => folders.findIndex((other) => other.toLowerCase() === dir.toLowerCase()) === index);
}

/** `reg query <hive> /s`, each hive failing on its own. */
export async function readHives(hives: readonly string[], query: (args: readonly string[]) => Promise<string | null>): Promise<RegistryKey[]> {
    const lists = await Promise.all(hives.map((hive) => query([hive, "/s"]).then((text) => (text ? parseRegQuery(text) : []), () => [])));
    return lists.flat();
}
