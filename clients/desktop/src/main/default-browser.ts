/**
 * The default browser on Windows, started directly.
 *
 * `shell.openExternal` hands a link to Windows and trusts it to start the
 * browser. On some machines that hand-over fails without a word (BUG-0020): no
 * rejection, no browser. This reads the same registration Windows would use -
 * the scheme's `UserChoice` ProgId, then that ProgId's `shell\open\command` -
 * and starts the program it names with the link as one argument, then reads
 * the started process's exit code to learn whether the link was taken - which
 * the hand-over never says.
 *
 * The command line is parsed here, never given to a shell: the program and its
 * arguments go to `spawn` as an array, so nothing in a link is ever read as a
 * command.
 */

import { win32 } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

/** Reads one value from the registry: null when the key or value is not there. */
export type RegistryReader = (key: string, value: string | null) => Promise<string | null>;

/** Starts a program detached; resolves once it took the link, rejects when it did not. */
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
 * Exit codes of a browser process that handed its link to the copy already
 * running. 0 is Firefox's remote hand-over and Chromium's fast path
 * (`chrome_exe_main_win.cc`, which the `--single-argument` switch every
 * Chromium browser registers skips); 24 is Chromium's
 * `NORMAL_EXIT_PROCESS_NOTIFIED` (`chrome/common/chrome_result_codes.h`),
 * the code Brave, Chrome, Edge, Opera and Vivaldi exit with once the running
 * browser took the link.
 */
const HANDED_OVER = new Set([0, 24]);

/** What a browser process's exit code says about the link it was given. */
export function exitMeaning(code: number | null): string {
    if (code === 21) return "the browser reported its profile in use: it could not reach its own open window to give it the link";
    if (code === null) return "the browser was stopped before it took the link";
    return "the browser exited without taking the link";
}

/** How long a started browser has to hand its link over before it counts as the
 *  browser itself - a cold start that keeps running. A hand-over is a message
 *  to the running copy and ends in about a second. */
export const SETTLE_MS = 8_000;

/**
 * Variables Electron and Chromium read to change how a Chromium program starts:
 * `CHROME_CRASHPAD_PIPE_NAME` makes a Chromium process report to another
 * program's crash handler (`components/crash/core/app/crashpad_win.cc`),
 * `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` change what a Node-based program
 * does. None of them is Polaris's to hand to a browser.
 */
const CHROMIUM_VARIABLES = /^(?:ELECTRON_|CHROME_|NODE_OPTIONS$)/i;

/** The environment a started browser is given: Polaris's own, without the
 *  variables only Electron or Chromium read. */
export function browserEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !CHROMIUM_VARIABLES.test(name)));
}

/**
 * Hand `url` to the Windows shell that draws the desktop, so the shell starts
 * the browser - the way a link clicked anywhere else in Windows is opened.
 *
 * A second `explorer.exe` does not open the address itself: it passes its
 * command line to the Explorer already running and exits. The browser is then
 * started by that Explorer, outside Polaris's process tree, with nothing of
 * Polaris's (its job, its token, its environment) inherited - the same reason
 * `explorer.exe <program>` is the known way to start a program unelevated
 * from an elevated one (Raymond Chen, "How can I launch an unelevated process
 * from my elevated process", The Old New Thing, 2013-11-18). Explorer's exit
 * code is 1 whether or not it handed the address on, so it says nothing:
 * resolving means Windows started Explorer with the address, not that a page
 * opened. Rejects with `ShellUnavailable` for an address Explorer would read as
 * more than one argument: it splits its command line at commas.
 */
export function handToShell(url: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    return new Promise((resolve, reject) => {
        // `new URL().href` encodes a quote, so the address cannot close its own
        // quotes; a comma is left as it is, and Explorer would split there.
        if (/[",\s]/.test(url)) {
            reject(new ShellUnavailable("Explorer would split this address at its comma"));
            return;
        }
        const explorer = win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? String.raw`C:\Windows`, "explorer.exe");
        if (!existsSync(explorer)) {
            reject(new ShellUnavailable(`${explorer} is not there`));
            return;
        }
        const child = spawn(explorer, [`"${url}"`], { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: true, env: browserEnvironment(env) });
        child.once("error", (error) => reject(error));
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

/** `handToShell` cannot be used for this address or on this machine; not a
 *  refusal of the link. */
export class ShellUnavailable extends Error {}

/**
 * Start the browser detached and wait for what it does with the link.
 *
 * Starting the process is not opening the link. With the browser already
 * running, the started process is only a messenger: it gives the link to the
 * running copy and exits. Counting the start as success (desktop 0.1.60-0.1.90)
 * reported a refused hand-over as opened, so no other route was tried and
 * nothing was said (BUG-0020). Resolves when the process exits with a
 * hand-over code, or is still running after `SETTLE_MS` (it became the
 * browser); rejects with the exit code otherwise.
 */
export function launchDetached(file: string, args: readonly string[], settleMs: number = SETTLE_MS, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!existsSync(file)) {
            reject(new Error(`${file} is not there`));
            return;
        }
        const child = spawn(file, [...args], { detached: true, stdio: "ignore", windowsHide: false, env: browserEnvironment(env) });
        let settled = false;
        const finish = (error: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => finish(null), settleMs);
        child.once("error", (error) => finish(error));
        child.once("spawn", () => child.unref());
        child.once("exit", (code) => {
            if (code !== null && HANDED_OVER.has(code)) finish(null);
            else finish(new Error(`${file} exited with code ${String(code)}: ${exitMeaning(code)}`));
        });
    });
}

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
