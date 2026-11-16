/**
 * The workspace a Polar session uses when an editor drives it over the Agent
 * Client Protocol: the machine's own files and processes, except where the
 * editor offered to do the work itself.
 *
 * - `fs.readTextFile` / `fs.writeTextFile`: files go through the editor, so a
 *   read sees the unsaved buffer the person is looking at and a write lands
 *   in it (and in its undo history). A file the editor cannot read as text
 *   (an image, a binary) falls back to the disk.
 * - `terminal`: a command runs in an editor terminal the person can watch,
 *   and `onTerminal` names it so the tool call shows it. A command fed on
 *   standard input stays local: a protocol terminal has no input.
 *
 * Everything else (background shells, language servers, listings) is the
 * machine's, through the node workspace it wraps.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { ExecOptions, ExecResult, Workspace } from "@/lib/polar/native/workspace";

/** The most one command's output the editor is asked to keep. */
export const ACP_TERMINAL_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The editor side the workspace calls: the agent's view of the client. */
export interface AcpClientCalls {
    request<Method extends "fs/read_text_file" | "fs/write_text_file">(
        method: Method,
        params: Method extends "fs/read_text_file" ? acp.ReadTextFileRequest : acp.WriteTextFileRequest
    ): Promise<unknown>;
    createTerminal(params: acp.CreateTerminalRequest): Promise<AcpTerminal>;
}

/** What the workspace needs of a terminal (`TerminalHandle`). */
export interface AcpTerminal {
    readonly id: string;
    currentOutput(): Promise<acp.TerminalOutputResponse>;
    waitForExit(): Promise<acp.WaitForTerminalExitResponse>;
    kill(): Promise<unknown>;
    release(): Promise<unknown>;
}

export interface AcpWorkspaceOptions {
    readonly sessionId: string;
    readonly capabilities: acp.ClientCapabilities | undefined;
    readonly client: AcpClientCalls;
    /** A terminal was opened for the call in progress. */
    readonly onTerminal?: (terminalId: string) => void;
}

export function acpWorkspace(base: Workspace, options: AcpWorkspaceOptions): Workspace {
    const fsCaps = options.capabilities?.fs;
    const canRead = fsCaps?.readTextFile === true;
    const canWrite = fsCaps?.writeTextFile === true;
    const canRun = options.capabilities?.terminal === true;

    async function runInTerminal(argv: readonly string[], exec: ExecOptions): Promise<ExecResult> {
        const [command, ...args] = argv;
        const terminal = await options.client.createTerminal({
            sessionId: options.sessionId,
            command: command ?? "",
            args,
            cwd: exec.cwd ?? base.root,
            env: Object.entries(exec.env ?? {}).map(([name, value]) => ({ name, value })),
            outputByteLimit: ACP_TERMINAL_OUTPUT_BYTES
        });
        options.onTerminal?.(terminal.id);
        let timedOut = false;
        let aborted = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = new Promise<"stopped">((resolve) => {
            if (exec.timeoutMs) {
                timer = setTimeout(() => {
                    timedOut = true;
                    resolve("stopped");
                }, exec.timeoutMs);
            }
            const onAbort = () => {
                aborted = true;
                resolve("stopped");
            };
            if (exec.signal?.aborted) onAbort();
            else exec.signal?.addEventListener("abort", onAbort, { once: true });
        });
        try {
            const exit = await Promise.race([terminal.waitForExit(), stop]);
            if (exit === "stopped") await terminal.kill().catch(() => undefined);
            const output = await terminal.currentOutput();
            const code = exit === "stopped" ? null : (exit.exitCode ?? null);
            return { stdout: output.output, stderr: "", code, timedOut, aborted };
        } finally {
            clearTimeout(timer);
            await terminal.release().catch(() => undefined);
        }
    }

    return {
        root: base.root,
        platform: base.platform,
        exec(argv, exec = {}) {
            if (!canRun || exec.input !== undefined || argv.length === 0) return base.exec(argv, exec);
            return runInTerminal(argv, exec);
        },
        spawnBackground: (argv, spawn) => base.spawnBackground(argv, spawn),
        ...(base.spawnPiped ? { spawnPiped: base.spawnPiped.bind(base) } : {}),
        async readFile(file) {
            if (!canRead) return base.readFile(file);
            try {
                const answer = (await options.client.request("fs/read_text_file", {
                    sessionId: options.sessionId,
                    path: file
                })) as acp.ReadTextFileResponse;
                if (typeof answer?.content === "string") return Buffer.from(answer.content, "utf8");
            } catch {
                // Not a text file the editor holds, or one it refused: the disk decides.
            }
            return base.readFile(file);
        },
        async writeFile(file, data) {
            if (!canWrite) return base.writeFile(file, data);
            await options.client.request("fs/write_text_file", { sessionId: options.sessionId, path: file, content: data });
        },
        stat: (file) => base.stat(file),
        list: (dir) => base.list(dir),
        has: (program) => base.has(program)
    };
}
