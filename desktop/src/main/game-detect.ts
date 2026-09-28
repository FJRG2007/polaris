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
 * Reading the list is one system command every `CHECK_MS`, cheap enough to
 * leave running: `tasklist` on Windows, `ps` on macOS, and `/proc` on Linux,
 * where a program's name in `ps` is cut to fifteen characters and a game run
 * through a compatibility layer is known by its Windows program name, which is
 * the first word of its command line.
 *
 * The parsers are pure and tested; the reading is not, because it needs the
 * operating system it is reading.
 */

import { execFile } from "node:child_process";
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

/**
 * The game running, out of these program names, or null.
 *
 * Somebody's own additions come first, so a program they named themselves is
 * called what they called it, even when it is also on the built-in list.
 */
export function matchGame(
    running: Iterable<string>,
    custom: readonly CustomGame[] = [],
    known: readonly KnownGame[] = KNOWN_GAMES
): { key: string; name: string } | null {
    const names = new Set([...running].map(programKey));
    for (const game of custom) {
        const key = programKey(game.executable);
        if (names.has(key)) return { key, name: game.name };
    }
    for (const game of known) {
        const program = game.programs.find((entry) => names.has(entry));
        if (program) return { key: program, name: game.name };
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

/**
 * Watches for a game and says when it starts, stops, and - while it runs - that
 * it is still running.
 *
 * `onChange` is called with the game, or null when none is running any more; the
 * first check after starting says whichever it is, so the dashboard is told the
 * truth after the app restarts. A check that fails (a command that would not
 * run) changes nothing: not being able to look is not the same as nothing
 * running.
 */
export class GameWatcher {
    private current: RunningGame | null = null;
    private said = 0;
    private custom: readonly CustomGame[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private first = true;

    constructor(
        private readonly onChange: (game: RunningGame | null) => void,
        private readonly list: () => Promise<string[]> = () => runningPrograms()
    ) {}

    /** The programs somebody added as games, from the dashboard. */
    setCustomGames(games: readonly CustomGame[]): void {
        this.custom = games;
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
        let programs: string[];
        try {
            programs = await this.list();
        } catch {
            return;
        }
        const found = matchGame(programs, this.custom);
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

    private say(game: RunningGame | null, now: number): void {
        this.said = now;
        this.onChange(game);
    }
}
