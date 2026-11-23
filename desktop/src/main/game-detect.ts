/**
 * Which game is running on this computer, the way Discord tells: by looking at
 * the list of running programs and matching it against games it knows.
 *
 * Only the matched game ever leaves this module - its name, its program and when
 * it was first seen. The rest of the process list stays on the computer; the
 * one exception is the settings page asking, on a press, for the names of what
 * is running so somebody can pick one to add as a game, and that list goes to
 * the page on screen and nowhere else.
 *
 * Reading the list is one look every `CHECK_MS`, cheap enough to leave
 * running: a PowerShell kept open and asked again on Windows (`WindowsLister`),
 * which also says where each program lives, so a game an installed store
 * (Epic, Steam, GOG, Ubisoft) put in a folder is known by that store's name
 * for it without being on any list here; `ps` on macOS, and `/proc` on Linux,
 * where a program's name in `ps` is cut to fifteen characters and a game run
 * through a compatibility layer is known by its Windows program name, which is
 * the first word of its command line.
 *
 * The parsers are pure and tested; the reading is not, because it needs the
 * operating system it is reading.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { KNOWN_GAMES, type KnownGame } from "./known-games";

/** How often the process list is read. */
export const CHECK_MS = 15_000;

/** How often a game that is still running is said again, which is what keeps
 *  the card beside somebody's name alive (the dashboard forgets one after three
 *  minutes without hearing). */
export const REPEAT_MS = 60_000;

/** A program somebody said is a game. */
export interface CustomGame {
    readonly executable: string;
    readonly name: string;
}

/** A running program: its name, and on Windows the file it was started from when that could be read. */
export interface RunningProcess {
    readonly name: string;
    readonly path?: string;
    /** On Windows, set on the program whose window is in front: whether that window covers its whole screen. */
    readonly foreground?: "window" | "fullscreen";
}

/** What a look returns: bare names where the system gives nothing more. */
export type Seen = string | RunningProcess;

/** An installed store game: the folder its store put it in, and the store's name for it. */
export interface StoreGame {
    readonly name: string;
    readonly folder: string;
}

/** The game running now, as it is reported. */
export interface RunningGame {
    readonly key: string;
    readonly name: string;
    /** When this app first saw it, as an ISO moment. */
    readonly startedAt: string;
}

/** A program's own name, lowercased, without its folder - the dashboard's key. */
export function programKey(path: string): string {
    return (path.trim().split(/[\\/]/).at(-1) ?? "").trim().toLowerCase();
}

/** Every image name in `tasklist /fo csv /nh` output. */
export function parseTasklist(text: string): string[] {
    const names: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const match = /^"([^"]+)"/.exec(line.trim());
        if (match?.[1]) names.push(programKey(match[1]));
    }
    return names;
}

/** The most programs one look keeps, and the longest path kept with one. */
const MAX_PROCESSES = 5000;
const MAX_PATH_CHARS = 1024;

/** Every program in the `name<TAB>path<TAB>front` lines `WindowsLister`
 *  reads back, `front` being `f` on the program whose window is in front (`F`
 *  when it covers its screen); a line without a path (a process that could not
 *  be opened, or a shell that only gave names) keeps only its name. */
export function parseProcessList(text: string): RunningProcess[] {
    const out: RunningProcess[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (out.length >= MAX_PROCESSES) break;
        const [rawName = "", rawPath = "", front = ""] = line.split("\t");
        const path = rawPath.trim();
        const usable = path.length <= MAX_PATH_CHARS && /^[A-Za-z]:\\/.test(path);
        if (!rawName.trim() && !usable) continue;
        const foreground = front.trim() === "F" ? "fullscreen" : front.trim() === "f" ? "window" : null;
        out.push({
            name: programKey(usable ? path : `${rawName.trim()}.exe`),
            ...(usable ? { path } : {}),
            ...(foreground ? { foreground } : {})
        });
    }
    return out;
}

/** Every program in `ps -A -o comm=` output, which on macOS is a full path. */
export function parsePs(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => programKey(line))
        .filter(Boolean);
}

/** A program's name from a `/proc/<pid>/cmdline`: its first argument, which for a
 *  game under a compatibility layer is the Windows path of the game itself when
 *  the layer is not the first word. */
export function parseCmdline(raw: string): string[] {
    const args = raw.split("\u0000").filter(Boolean);
    const found: string[] = [];
    const first = args[0];
    if (first) found.push(programKey(first));
    // `wine game.exe`, `wine64-preloader Z:\...\game.exe`: the game is whichever
    // argument ends in `.exe`.
    const exe = args.find((arg) => /\.exe$/i.test(arg.trim()));
    if (exe && exe !== first) found.push(programKey(exe));
    return found.filter(Boolean);
}

/** A folder as it is compared: lowercased, backslashes, no trailing separator. */
function folderKey(path: string): string {
    return path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** Folders a store record could name that hold far more than one game. */
const SHARED_FOLDERS = new Set([
    "program files", "program files (x86)", "programdata", "windows", "users", "appdata", "games", "common",
    "steamapps", "steamlibrary", "steam", "epic games", "gog games", "gog galaxy", "ubisoft", "ubisoft game launcher",
    "xboxgames", "windowsapps"
]);

/** Programs that run from a game's folder without being the game: crash
 *  reporters, anti-cheat services, installers and the store's helpers. */
const HELPER = /crash|report|unins|redist|setup|prereq|easyanticheat|battleye|beservice|webhelper|cefsharp|dotnet/i;

/**
 * Store games' folders made ready to compare, leaving out a drive's root and
 * any folder that holds more than one game (`C:\Program Files`, a Steam
 * library's `common`), so a store record pointing at one never makes every
 * program under it a game. The longest folder comes first, so a game installed
 * inside another's folder is called by its own name.
 */
export function storeGameFolders(games: readonly StoreGame[]): StoreGame[] {
    return games
        .map((game) => ({ name: game.name.trim(), folder: folderKey(game.folder) }))
        .filter((game) => game.name !== "" && /^[a-z]:\\./.test(game.folder) && !SHARED_FOLDERS.has(game.folder.split("\\").at(-1) ?? ""))
        .sort((a, b) => b.folder.length - a.folder.length);
}

/** The installed store game `path` was started from, out of `storeGameFolders` output. */
function storeGameOf(path: string, folders: readonly StoreGame[]): StoreGame | null {
    const file = folderKey(path);
    if (HELPER.test(programKey(file))) return null;
    return folders.find((game) => file.startsWith(`${game.folder}\\`)) ?? null;
}

/**
 * The game running, out of these programs, or null.
 *
 * Somebody's own additions come first, so a program they named themselves is
 * called what they called it, even when it is also on the built-in list. Then
 * the built-in list, then any program started from inside an installed store
 * game's folder, named the way its store names it. `folders` is
 * `storeGameFolders` output.
 */
export function matchGame(
    running: Iterable<Seen>,
    custom: readonly CustomGame[] = [],
    known: readonly KnownGame[] = KNOWN_GAMES,
    folders: readonly StoreGame[] = []
): { key: string; name: string } | null {
    const seen = [...running].map((entry): RunningProcess => (typeof entry === "string" ? { name: entry } : entry));
    const names = new Set(seen.map((entry) => programKey(entry.name)));
    for (const game of custom) {
        const key = programKey(game.executable);
        if (names.has(key)) return { key, name: game.name };
    }
    for (const game of known) {
        const program = game.programs.find((entry) => names.has(entry));
        if (program) return { key: program, name: game.name };
    }
    if (folders.length === 0) return null;
    for (const entry of seen) {
        const game = entry.path ? storeGameOf(entry.path, folders) : null;
        if (game) return { key: programKey(entry.name), name: game.name };
    }
    return null;
}

function run(command: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            command,
            [...args],
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
            (error, stdout) => (error ? reject(error) : resolve(stdout))
        );
    });
}

/** The names of every program running on this computer. */
export async function runningPrograms(platform: NodeJS.Platform = process.platform): Promise<string[]> {
    if (platform === "win32") return parseTasklist(await run("tasklist", ["/fo", "csv", "/nh"]));
    if (platform === "linux") {
        const entries = await readdir("/proc").catch(() => [] as string[]);
        const names: string[] = [];
        await Promise.all(
            entries
                .filter((entry) => /^\d+$/.test(entry))
                .map(async (pid) => {
                    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
                    names.push(...parseCmdline(raw));
                })
        );
        return names;
    }
    return parsePs(await run("ps", ["-A", "-o", "comm="]));
}

/** What a `WindowsLister` starts: PowerShell reading commands from its input. */
export type SpawnLister = () => ChildProcessWithoutNullStreams;

/** The line PowerShell writes after each list, so a reply is known to be whole. */
const LIST_END = "<<polaris-list-end>>";

/** How long one list may take before the shell is taken for stuck; a new
 *  shell gets longer, since its first list waits on the reader being compiled. */
const LIST_TIMEOUT_MS = 10_000;
const FIRST_LIST_TIMEOUT_MS = 30_000;

/** The most one list may print before it is taken for broken (~5000 programs with long paths). */
const MAX_LIST_CHARS = 4 * 1024 * 1024;

/**
 * The reader the shell compiles once: every process's name and the file it was
 * started from, as `name<TAB>path` lines in one string, the program whose
 * window is in front marked `f` in a third column, or `F` when that window
 * covers its whole screen (the desktop itself never counts). The path comes from
 * `QueryFullProcessImageName` with the least access Windows has
 * (`PROCESS_QUERY_LIMITED_INFORMATION`), which answers for nearly every
 * process, elevated games included, and quickly - where PowerShell's own
 * `Path` walks each process's modules and fails on anything elevated. One
 * line, with no single quote in it, since it travels inside one.
 */
const READER_TYPE = "PolarisProcessList";
export const READER_SOURCE = [
    "using System;using System.Text;using System.Diagnostics;using System.Runtime.InteropServices;",
    `public static class ${READER_TYPE}{`,
    "[DllImport(\"kernel32.dll\")]static extern IntPtr OpenProcess(uint access,bool inherit,int id);",
    "[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder name,ref uint size);",
    "[DllImport(\"kernel32.dll\")]static extern bool CloseHandle(IntPtr handle);",
    "[DllImport(\"user32.dll\")]static extern IntPtr GetForegroundWindow();",
    "[DllImport(\"user32.dll\")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint id);",
    "[DllImport(\"user32.dll\")]static extern bool GetWindowRect(IntPtr window,out Box box);",
    "[DllImport(\"user32.dll\")]static extern IntPtr MonitorFromWindow(IntPtr window,uint flags);",
    "[DllImport(\"user32.dll\")]static extern bool GetMonitorInfo(IntPtr monitor,ref Screen info);",
    "[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr window,StringBuilder name,int size);",
    "[StructLayout(LayoutKind.Sequential)]public struct Box{public int Left,Top,Right,Bottom;}",
    "[StructLayout(LayoutKind.Sequential)]public struct Screen{public int Size;public Box Monitor;public Box Work;public uint Flags;}",
    "public static string Read(){uint front=0;bool full=false;",
    "try{var w=GetForegroundWindow();if(w!=IntPtr.Zero){GetWindowThreadProcessId(w,out front);var c=new StringBuilder(64);GetClassName(w,c,64);var k=c.ToString();",
    "if(k!=\"Progman\"&&k!=\"WorkerW\"){Box b;var m=new Screen();m.Size=Marshal.SizeOf(typeof(Screen));",
    "if(GetWindowRect(w,out b)&&GetMonitorInfo(MonitorFromWindow(w,2),ref m))full=b.Left<=m.Monitor.Left&&b.Top<=m.Monitor.Top&&b.Right>=m.Monitor.Right&&b.Bottom>=m.Monitor.Bottom;}}}catch{}",
    "var o=new StringBuilder();foreach(var p in Process.GetProcesses()){string path=\"\";",
    "try{var h=OpenProcess(0x1000,false,p.Id);if(h!=IntPtr.Zero){var s=new StringBuilder(1024);uint n=1024;if(QueryFullProcessImageName(h,0,s,ref n))path=s.ToString();CloseHandle(h);}}catch{}",
    "try{o.Append(p.ProcessName).Append(\"\\t\").Append(path);if(front!=0&&p.Id==front)o.Append(full?\"\\tF\":\"\\tf\");o.Append(\"\\n\");}catch{}p.Dispose();}return o.ToString();}}"
].join("");

/** One list: the compiled reader, or the bare names when it could not be compiled. */
const LIST_COMMAND = `if ('${READER_TYPE}' -as [type]) { [${READER_TYPE}]::Read() } else { (Get-Process).ProcessName }; '${LIST_END}'\n`;

/**
 * The running programs on Windows, read every `CHECK_MS` by one PowerShell that
 * stays open. `tasklist` was measured at 1.2-1.5 s of processor per run on a
 * machine with ~500 processes, every 15 s for as long as the app ran; the open
 * shell answers the same question in ~15 ms. It exits by itself when this app
 * does, since its input closes. A shell that cannot start, or stops answering,
 * gives way to `tasklist` for that look and is started again on the next.
 * Where the reader cannot be compiled (a locked-down PowerShell), the shell
 * still answers with names, and only the store-folder match is lost.
 */
export class WindowsLister {
    private child: ChildProcessWithoutNullStreams | null = null;
    private pending: Promise<RunningProcess[]> | null = null;
    private fresh = false;

    constructor(
        private readonly start: SpawnLister = () =>
            spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true }),
        private readonly fallback: () => Promise<string[]> = async () => parseTasklist(await run("tasklist", ["/fo", "csv", "/nh"]))
    ) {}

    /** One list; a second asked while one is on its way gets the same answer. */
    list(): Promise<RunningProcess[]> {
        this.pending ??= this.ask()
            .catch(async () => {
                this.stop();
                return (await this.fallback()).map((name) => ({ name }));
            })
            .finally(() => {
                this.pending = null;
            });
        return this.pending;
    }

    stop(): void {
        this.child?.kill();
        this.child = null;
    }

    private shell(): ChildProcessWithoutNullStreams {
        if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
        const child = this.start();
        child.stdout.setEncoding("utf8");
        child.stderr.resume();
        child.on("error", () => undefined);
        child.on("exit", () => {
            if (this.child === child) this.child = null;
        });
        // Names outside the console's code page arrive as themselves.
        child.stdin.write("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n");
        child.stdin.write(`try { Add-Type -TypeDefinition '${READER_SOURCE}' -ErrorAction Stop } catch { }\n`);
        this.child = child;
        this.fresh = true;
        return child;
    }

    private ask(): Promise<RunningProcess[]> {
        const child = this.shell();
        const timeout = this.fresh ? FIRST_LIST_TIMEOUT_MS : LIST_TIMEOUT_MS;
        this.fresh = false;
        return new Promise((resolve, reject) => {
            // Chunks are kept apart and only the seam is searched, so a long list is read once, not once per chunk.
            const chunks: string[] = [];
            let size = 0;
            let tail = "";
            const done = (error: Error | null, list = "") => {
                clearTimeout(timer);
                child.stdout.off("data", heard);
                child.off("exit", gone);
                if (error) reject(error);
                else resolve(parseProcessList(list));
            };
            const heard = (data: string | Buffer) => {
                const chunk = String(data);
                const seam = tail + chunk;
                const at = seam.indexOf(LIST_END);
                if (at !== -1) {
                    const text = chunks.join("") + chunk;
                    return done(null, text.slice(0, size - tail.length + at));
                }
                chunks.push(chunk);
                size += chunk.length;
                tail = seam.slice(-LIST_END.length);
                if (size > MAX_LIST_CHARS) done(new Error("The process list was too long."));
            };
            const gone = () => done(new Error("The process list stopped."));
            const timer = setTimeout(() => done(new Error("The process list did not answer.")), timeout);
            child.stdout.on("data", heard);
            child.once("exit", gone);
            child.stdin.write(LIST_COMMAND, (error) => {
                if (error) done(error);
            });
        });
    }
}

/** The watcher's look: the open shell on Windows, `runningPrograms` elsewhere. */
function watchedPrograms(): () => Promise<readonly Seen[]> {
    if (process.platform !== "win32") return () => runningPrograms();
    const lister = new WindowsLister();
    return () => lister.list();
}

/**
 * Watches for a game and says when it starts, stops, and - while it runs - that
 * it is still running.
 *
 * `onChange` is called with the game, or null when none is running any more; the
 * first check after starting says whichever it is, so the dashboard is told the
 * truth after the app restarts. A check that fails (a command that would not
 * run) changes nothing: not being able to look is not the same as nothing
 * running.
 *
 * `games` is the installed store games as last listed by whoever keeps that
 * list (the launcher's): asked on each look and expected to answer from memory,
 * never to read the stores, so a look stays one process read.
 *
 * The same look says whether a game - or any window covering its screen that
 * is not this app's own - is in front (`onForeground`), on Windows, where the
 * list marks the program in front; elsewhere it is never said to be.
 */
export class GameWatcher {
    private current: RunningGame | null = null;
    private said = 0;
    private custom: readonly CustomGame[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private first = true;
    private storeGames: readonly StoreGame[] | null = null;
    private folders: readonly StoreGame[] = [];
    private inFront = false;
    private frontListener: ((busy: boolean) => void) | null = null;

    constructor(
        private readonly onChange: (game: RunningGame | null) => void,
        private readonly list: () => Promise<readonly Seen[]> = watchedPrograms(),
        private readonly games: () => readonly StoreGame[] = () => [],
        /** This app's own program, whose full-screen windows are not somebody playing. */
        private readonly ownPath: string = process.execPath
    ) {}

    /** Told, when it changes, whether a game or a full-screen window is in front. */
    onForeground(listener: (busy: boolean) => void): void {
        this.frontListener = listener;
    }

    /** Whether a game or a full-screen window was in front at the last look. */
    gameInFront(): boolean {
        return this.inFront;
    }

    /** The programs somebody added as games, from the dashboard. */
    setCustomGames(games: readonly CustomGame[]): void {
        this.custom = games;
        // Looked at again now rather than at the next tick, so a game added
        // while it is already running is recognized the moment it is added.
        if (this.timer) void this.check();
    }

    /** What is running now, as last seen. */
    running(): RunningGame | null {
        return this.current;
    }

    start(): void {
        if (this.timer) return;
        void this.check();
        this.timer = setInterval(() => void this.check(), CHECK_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One look. Public for the tests; the timer is what calls it. */
    async check(now: number = Date.now()): Promise<void> {
        let programs: readonly Seen[];
        try {
            programs = await this.list();
        } catch {
            return;
        }
        const found = matchGame(programs, this.custom, KNOWN_GAMES, this.storeFolders());
        this.followFront(programs, found?.key ?? null);
        const same = found && this.current && found.key === this.current.key && found.name === this.current.name;
        if (same) {
            if (now - this.said >= REPEAT_MS) this.say(this.current, now);
            return;
        }
        if (!found && !this.current && !this.first) return;
        this.first = false;
        this.current = found ? { ...found, startedAt: new Date(now).toISOString() } : null;
        this.say(this.current, now);
    }

    private followFront(programs: readonly Seen[], game: string | null): void {
        const front = programs.find((entry): entry is RunningProcess => typeof entry !== "string" && entry.foreground !== undefined);
        const own = front?.path !== undefined && front.path.toLowerCase() === this.ownPath.toLowerCase();
        const busy = front !== undefined && !own && (front.foreground === "fullscreen" || programKey(front.name) === game);
        if (busy === this.inFront) return;
        this.inFront = busy;
        this.frontListener?.(busy);
    }

    /** The store games ready to compare, made again only when a new listing arrives. */
    private storeFolders(): readonly StoreGame[] {
        const games = this.games();
        if (games !== this.storeGames) {
            this.storeGames = games;
            this.folders = storeGameFolders(games);
        }
        return this.folders;
    }

    private say(game: RunningGame | null, now: number): void {
        this.said = now;
        this.onChange(game);
    }
}
