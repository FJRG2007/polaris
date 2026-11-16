/**
 * Where a native session's tools act: the checkout on the session container,
 * or on the person's computer under the runner. The engine never touches the
 * filesystem or spawns a process except through this, so the same tools run
 * in both places and a test drives them against a temporary folder.
 *
 * `nodeWorkspace` is the one implementation: plain `node:fs` and
 * `node:child_process`, with every process started from an argument array and
 * no shell of its own. Only the Bash tool asks for a shell, and it names it.
 *
 * Server-free: no Polaris import, so it bundles into the session process.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";

export interface ExecOptions {
    /** Absolute working directory; the workspace root when absent. */
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    /** Extra environment on top of the session's own. */
    readonly env?: Readonly<Record<string, string>>;
    /** Text written to standard input, then closed. */
    readonly input?: string;
}

export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    /** Null when the process was killed. */
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly aborted: boolean;
}

export interface BackgroundProcess {
    readonly pid: number | undefined;
    /** Everything written so far, standard output and error interleaved. */
    output(): string;
    /** Null while it runs. */
    exitCode(): number | null | undefined;
    running(): boolean;
    kill(): void;
}

/** A long-lived process spoken to over its standard input and output (a
 *  language server). Its standard error is dropped. */
export interface PipedProcess {
    write(data: string | Buffer): void;
    onData(listener: (chunk: Buffer) => void): void;
    /** Once, when it exits or fails to start. */
    onExit(listener: () => void): void;
    kill(): void;
}

export interface FileStat {
    readonly kind: "file" | "directory" | "other";
    readonly size: number;
    readonly mtimeMs: number;
}

export interface Workspace {
    /** The checkout's absolute path. */
    readonly root: string;
    readonly platform: NodeJS.Platform;
    exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
    spawnBackground(argv: readonly string[], options?: { cwd?: string }): BackgroundProcess;
    /** Absent where a workspace cannot hold a process open. */
    spawnPiped?(argv: readonly string[], options?: { cwd?: string }): PipedProcess;
    readFile(file: string): Promise<Buffer>;
    writeFile(file: string, data: string): Promise<void>;
    stat(file: string): Promise<FileStat | null>;
    /** One directory's entries, names only. */
    list(dir: string): Promise<{ name: string; kind: FileStat["kind"] }[]>;
    /** Whether a program is on the PATH. */
    has(program: string): Promise<boolean>;
}

/** The longest any one process's output is kept in memory. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

function killTree(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null) return;
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return;
    }
    try {
        // Started detached, so the negative pid is its whole process group.
        process.kill(-child.pid, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}

export function nodeWorkspace(root: string, baseEnv: NodeJS.ProcessEnv = process.env): Workspace {
    const absolute = path.resolve(root);
    const envOf = (extra?: Readonly<Record<string, string>>) => ({ ...baseEnv, ...extra });

    return {
        root: absolute,
        platform: process.platform,
        exec(argv, options = {}) {
            return new Promise((resolve) => {
                const [program, ...args] = argv;
                if (!program) {
                    resolve({ stdout: "", stderr: "no program", code: 127, timedOut: false, aborted: false });
                    return;
                }
                const child = spawn(program, args, {
                    cwd: options.cwd ?? absolute,
                    env: envOf(options.env),
                    detached: process.platform !== "win32",
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"]
                });
                let stdout = "";
                let stderr = "";
                let timedOut = false;
                let aborted = false;
                const take = (current: string, chunk: Buffer) =>
                    current.length >= MAX_CAPTURE_BYTES ? current : current + chunk.toString("utf8");
                child.stdout?.on("data", (chunk: Buffer) => (stdout = take(stdout, chunk)));
                child.stderr?.on("data", (chunk: Buffer) => (stderr = take(stderr, chunk)));
                const timer =
                    options.timeoutMs !== undefined
                        ? setTimeout(() => {
                              timedOut = true;
                              killTree(child);
                          }, options.timeoutMs)
                        : null;
                const onAbort = () => {
                    aborted = true;
                    killTree(child);
                };
                options.signal?.addEventListener("abort", onAbort, { once: true });
                if (options.signal?.aborted) onAbort();
                child.on("error", (error) => {
                    stderr += String(error.message);
                });
                child.on("close", (code) => {
                    if (timer) clearTimeout(timer);
                    options.signal?.removeEventListener("abort", onAbort);
                    resolve({ stdout, stderr, code: timedOut || aborted ? null : code, timedOut, aborted });
                });
                child.stdin?.on("error", () => undefined);
                child.stdin?.end(options.input ?? "");
            });
        },
        spawnBackground(argv, options = {}) {
            const [program, ...args] = argv;
            const child = spawn(program ?? "", args, {
                cwd: options.cwd ?? absolute,
                env: envOf(),
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
            });
            let output = "";
            let exit: number | null | undefined;
            const take = (chunk: Buffer) => {
                if (output.length < MAX_CAPTURE_BYTES) output += chunk.toString("utf8");
            };
            child.stdout?.on("data", take);
            child.stderr?.on("data", take);
            child.on("error", (error) => {
                output += String(error.message);
                exit = 127;
            });
            child.on("close", (code) => {
                exit = code;
            });
            return {
                pid: child.pid,
                output: () => output,
                exitCode: () => exit,
                running: () => exit === undefined,
                kill: () => killTree(child)
            };
        },
        spawnPiped(argv, options = {}) {
            const [program, ...args] = argv;
            const child = spawn(program ?? "", args, {
                cwd: options.cwd ?? absolute,
                env: envOf(),
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["pipe", "pipe", "ignore"]
            });
            const exits: (() => void)[] = [];
            let exited = false;
            const finish = () => {
                if (exited) return;
                exited = true;
                for (const listener of exits) listener();
            };
            child.on("error", finish);
            child.on("close", finish);
            child.stdin?.on("error", () => undefined);
            return {
                write: (data) => {
                    if (!exited) child.stdin?.write(data);
                },
                onData: (listener) => child.stdout?.on("data", listener),
                onExit: (listener) => (exited ? listener() : exits.push(listener)),
                kill: () => killTree(child)
            };
        },
        readFile: (file) => fs.readFile(file),
        async writeFile(file, data) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, data, "utf8");
        },
        async stat(file) {
            try {
                const info = await fs.stat(file);
                return {
                    kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
                    size: info.size,
                    mtimeMs: info.mtimeMs
                };
            } catch {
                return null;
            }
        },
        async list(dir) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            return entries.map((entry) => ({
                name: entry.name,
                kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other"
            }));
        },
        async has(program) {
            const probe =
                process.platform === "win32"
                    ? await this.exec(["where", program], { timeoutMs: 5_000 })
                    : await this.exec(["sh", "-c", 'command -v "$1"', "sh", program], { timeoutMs: 5_000 });
            return probe.code === 0 && probe.stdout.trim() !== "";
        }
    };
}
