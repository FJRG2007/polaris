/**
 * The default browser on Windows, started directly.
 *
 * `shell.openExternal` hands a link to Windows and trusts it to start the
 * browser. On some machines that hand-over fails without a word (BUG-0020): no
 * rejection, no browser. This reads the same registration Windows would use -
 * the scheme's `UserChoice` ProgId, then that ProgId's `shell\open\command` -
 * and starts the program it names with the link as one argument. Starting a
 * process is something this side can see succeed or fail, which the hand-over
 * never was.
 *
 * The command line is parsed here, never given to a shell: the program and its
 * arguments go to `spawn` as an array, so nothing in a link is ever read as a
 * command.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

/** Reads one value from the registry: null when the key or value is not there. */
export type RegistryReader = (key: string, value: string | null) => Promise<string | null>;

/** Starts a program detached; resolves once the process exists. */
export type Launcher = (file: string, args: readonly string[]) => Promise<void>;

export interface Launch {
    readonly file: string;
    readonly args: readonly string[];
}

/** Programs a registered command may never be: each runs what it is given. */
const NEVER = new Set(["cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe", "mshta.exe", "rundll32.exe", "conhost.exe"]);

/**
 * One value out of `reg.exe query` output. The value's name is localised on
 * some systems ("(Default)", "(Predeterminado)"), so the line is read from its
 * type onwards rather than by name.
 */
export function parseRegQuery(output: string): string | null {
    for (const line of output.split(/\r?\n/)) {
        const found = /^\s+.*?\s{2,}(REG_(?:SZ|EXPAND_SZ))\s{2,}(.*)$/.exec(line);
        if (found?.[2] !== undefined) return found[2].trim() || null;
    }
    return null;
}

/** `%NAME%` replaced from the environment, as Windows does for a REG_EXPAND_SZ
 *  command. Placeholders like `%1` are not names and are left alone. */
function expandEnvironment(command: string, env: Readonly<Record<string, string | undefined>>): string {
    const byName = new Map(Object.entries(env).map(([name, value]) => [name.toLowerCase(), value]));
    return command.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole, name: string) => byName.get(name.toLowerCase()) ?? whole);
}

/** The program at the start of a command line, and where its arguments begin. */
function splitProgram(command: string): { file: string; rest: string; } | null {
    const text = command.trim();
    if (text.startsWith("\"")) {
        const end = text.indexOf("\"", 1);
        if (end < 0) return null;
        return { file: text.slice(1, end), rest: text.slice(end + 1) };
    }
    // Unquoted: Windows itself tries the path up to each space in turn; the
    // first `.exe` followed by a space or the end is the same answer.
    const exe = /^(.*?\.exe)(?=\s|$)/i.exec(text);
    if (exe?.[1]) return { file: exe[1], rest: text.slice(exe[1].length) };
    const space = text.search(/\s/);
    return space < 0 ? { file: text, rest: "" } : { file: text.slice(0, space), rest: text.slice(space) };
}

/**
 * Arguments as a Windows program splits its command line
 * (`CommandLineToArgvW`): spaces separate, quotes group, `""` inside quotes is
 * a quote, and backslashes are literal unless they precede a quote.
 */
export function splitArguments(text: string): string[] {
    const args: string[] = [];
    let current = "";
    let quoted = false;
    let started = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (char === "\\") {
            let slashes = 0;
            while (text[i] === "\\") {
                slashes++;
                i++;
            }
            if (text[i] === "\"") {
                current += "\\".repeat(Math.floor(slashes / 2));
                if (slashes % 2 === 1) current += "\"";
                else i--;
            } else {
                current += "\\".repeat(slashes);
                i--;
            }
            started = true;
            continue;
        }
        if (char === "\"") {
            if (quoted && text[i + 1] === "\"") {
                current += "\"";
                i++;
            } else quoted = !quoted;
            started = true;
            continue;
        }
        if (!quoted && /\s/.test(char)) {
            if (started) args.push(current);
            current = "";
            started = false;
            continue;
        }
        current += char;
        started = true;
    }
    if (started) args.push(current);
    return args;
}

/**
 * The program and arguments a registered `shell\open\command` runs for `url`.
 *
 * `%1`, `%l` and `%L` are the link; `%*` and the other numbered placeholders
 * have nothing to stand for here and are dropped. A command with no placeholder
 * gets the link as its last argument, as Windows does. Null for anything that
 * is not an absolute path to an `.exe`, and for a program that would run its
 * argument as a command.
 */
export function launchFor(command: string, url: string, env: Readonly<Record<string, string | undefined>> = {}): Launch | null {
    const program = splitProgram(expandEnvironment(command, env));
    if (!program) return null;
    const file = program.file.trim();
    if (!/^[A-Za-z]:\\/.test(file) || !/\.exe$/i.test(file)) return null;
    const name = file.slice(file.lastIndexOf("\\") + 1).toLowerCase();
    if (NEVER.has(name)) return null;
    let placed = false;
    const args: string[] = [];
    for (const arg of splitArguments(program.rest)) {
        if (/%[1lL]/.test(arg)) {
            args.push(arg.replace(/%[1lL]/g, () => url));
            placed = true;
            continue;
        }
        const left = arg.replace(/%[0-9*]/g, "");
        if (left !== "" || arg === "") args.push(left);
    }
    if (!placed) args.push(url);
    return { file, args };
}

/** A ProgId as the registry names one; anything else is not looked up. */
const PROG_ID = /^[A-Za-z0-9][\w.\-]{0,127}$/;

/**
 * The registered program for `url`'s scheme: the person's choice under
 * `UrlAssociations\<scheme>\UserChoice`, then that ProgId's open command.
 * Null when any step is missing - an app from the Store registers no command
 * here, and the system route is left to it.
 */
export async function registeredLaunch(url: string, read: RegistryReader, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Launch | null> {
    const scheme = new URL(url).protocol.slice(0, -1).toLowerCase();
    if (!["http", "https", "mailto"].includes(scheme)) return null;
    const progId = await read(`HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`, "ProgId");
    if (!progId || !PROG_ID.test(progId)) return null;
    const command = await read(`HKCR\\${progId}\\shell\\open\\command`, null);
    return command ? launchFor(command, url, env) : null;
}

/** `reg.exe query`, with an argument array and no shell. */
export const readRegistry: RegistryReader = (key, value) =>
    new Promise((resolve) => {
        const args = ["query", key, ...(value === null ? ["/ve"] : ["/v", value])];
        const child = spawn("reg.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        let output = "";
        const timer = setTimeout(() => child.kill(), 5_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (output.length < 64 * 1024) output += chunk;
        });
        child.on("error", () => {
            clearTimeout(timer);
            resolve(null);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve(code === 0 ? parseRegQuery(output) : null);
        });
    });

/**
 * Start a program detached from this one. Resolves once the operating system
 * has created the process - the one thing that can be confirmed: a browser that
 * is already running takes the link and lets the new process exit, with an
 * exit code that differs between browsers and says nothing about the link.
 */
export const launchDetached: Launcher = (file, args) =>
    new Promise((resolve, reject) => {
        if (!existsSync(file)) {
            reject(new Error(`${file} is not there`));
            return;
        }
        const child = spawn(file, [...args], { detached: true, stdio: "ignore", windowsHide: false });
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });

/**
 * A command-line opener on macOS (`open`) or Linux (`xdg-open`), whose exit code
 * does say whether the link was handed on. One that is still running after a
 * few seconds has started the browser itself and is taken as done.
 */
export function runOpener(file: string, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(file, [url], { windowsHide: true, detached: true, stdio: "ignore" });
        const timer = setTimeout(() => {
            child.unref();
            resolve();
        }, 3_000);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`${file} exited with ${String(code)}`));
        });
    });
}
