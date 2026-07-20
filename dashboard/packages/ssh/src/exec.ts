/**
 * Interactive and one-shot SSH channels over an already-open client. The client
 * (with its host-key pinning and auth) is owned by `openSshClient`; these helpers
 * only open channels on it, so every consumer - remote command execution, a PTY
 * terminal, SFTP, and DB port-forwarding - shares one audited connection path.
 */

import type { Client, ClientChannel, PseudoTtyOptions, SFTPWrapper } from "ssh2";

/** Terminal dimensions are bounded on both ends; this is the client-side clamp. */
const MIN_DIM = 1;
const MAX_COLS = 500;
const MAX_ROWS = 300;

export interface ExecResult {
    readonly code: number;
    readonly signal?: string;
}

export interface ExecOptions {
    readonly onStdout?: (chunk: Buffer) => void;
    readonly onStderr?: (chunk: Buffer) => void;
    /** Allocate a PTY (needed so a remote `docker logs -f`/`exec` dies on hangup). */
    readonly pty?: boolean | PseudoTtyOptions;
}

/** Run one command, streaming stdout/stderr; resolves with the remote exit code. */
export function execCommand(client: Client, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const handler = (error: Error | undefined, channel: ClientChannel): void => {
            if (error) return reject(error);
            channel.on("data", (chunk: Buffer) => options.onStdout?.(chunk));
            channel.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk));
            channel.once("close", (code: number | null, signal?: string) =>
                resolve({ code: code ?? 0, signal: signal ?? undefined })
            );
            channel.once("error", reject);
        };
        if (options.pty) client.exec(command, { pty: options.pty }, handler);
        else client.exec(command, handler);
    });
}

export interface ShellOptions {
    readonly cols?: number;
    readonly rows?: number;
    readonly term?: string;
}

/** Open an interactive PTY shell. The caller pipes the channel to a transport and
 *  owns closing the client. Dimensions are clamped before they reach the server. */
export function openShell(client: Client, options: ShellOptions = {}): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
        const window: PseudoTtyOptions = {
            term: options.term ?? "xterm-256color",
            cols: clampDim(options.cols, 80, MAX_COLS),
            rows: clampDim(options.rows, 24, MAX_ROWS)
        };
        client.shell(window, (error, channel) => (error ? reject(error) : resolve(channel)));
    });
}

/** Open an SFTP session on the client (used by the storage SFTP driver and the
 *  host file browser). */
export function openSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
        client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
    });
}

/** Open a direct-tcpip channel to a host:port reachable from the server. Used to
 *  tunnel a managed database's port to the control plane without publishing it. */
export function forwardOut(
    client: Client,
    dstHost: string,
    dstPort: number,
    srcHost = "127.0.0.1",
    srcPort = 0
): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
        client.forwardOut(srcHost, srcPort, dstHost, dstPort, (error, channel) =>
            error ? reject(error) : resolve(channel)
        );
    });
}

/** Clamp a requested terminal dimension into a sane range, defaulting if unset. */
export function clampDim(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(MIN_DIM, Math.min(max, Math.floor(value)));
}
