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
    /**
     * Fed to the command's stdin, which is then closed.
     *
     * This is how a secret reaches a remote command. The command line itself is
     * visible in `ps` to every user on the machine - sshd runs it through a login
     * shell - so anything that must not be readable there arrives here instead and
     * is read into a shell variable by the script.
     */
    readonly input?: string;
}

/** Run one command, streaming stdout/stderr; resolves with the remote exit code. */
export function execCommand(
    client: Client,
    command: string,
    options: ExecOptions = {}
): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const handler = (error: Error | undefined, channel: ClientChannel): void => {
            if (error) return reject(error);
            channel.on("data", (chunk: Buffer) => options.onStdout?.(chunk));
            channel.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk));
            channel.once("close", (code: number | null, signal?: string) =>
                resolve({ code: code ?? 0, signal: signal ?? undefined })
            );
            channel.once("error", reject);
            if (options.input !== undefined) channel.end(options.input);
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

/**
 * Open an interactive PTY shell as root, through the login's password-less sudo.
 *
 * `sudo -i` rather than `sudo -s`, so what comes back is a login shell with root's
 * environment and home rather than the calling account's - the difference shows up
 * later as a command that cannot find a tool on root's PATH.
 *
 * `-n` never prompts. A machine whose sudo would ask for a password fails here
 * immediately instead of presenting a password prompt into a terminal nobody can
 * answer it from, since the login has no password to begin with.
 */
export function openRootShell(client: Client, options: ShellOptions = {}): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
        client.exec(
            "sudo -n -i",
            {
                pty: {
                    term: options.term ?? "xterm-256color",
                    cols: clampDim(options.cols, 80, MAX_COLS),
                    rows: clampDim(options.rows, 24, MAX_ROWS)
                }
            },
            (error, channel) => (error ? reject(error) : resolve(channel))
        );
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

/**
 * The command a root SFTP session runs instead of the `sftp` subsystem: the
 * machine's own sftp-server, started through the login's password-less sudo.
 *
 * Fixed text with nothing interpolated into it. The candidates are where the
 * common distributions put the binary (Debian/Ubuntu, RHEL/Fedora, Arch,
 * Alpine/BSD); the first executable one replaces the shell. `-n` never prompts,
 * so a machine whose sudo wants a password ends the session at once instead of
 * waiting on a prompt nobody can answer.
 */
export const ROOT_SFTP_COMMAND =
    'sudo -n sh -c \'for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server; do [ -x "$p" ] && exec "$p"; done; exit 127\'';

/** The two channel requests of ssh2's client protocol this needs. */
interface ChannelRequests {
    subsystem(channel: number, name: string, wantReply: boolean): void;
    exec(channel: number, command: string, wantReply: boolean): void;
}

/** Clients whose SFTP channels already start as root. */
const rooted = new WeakSet<Client>();

/**
 * Open an SFTP session that runs as root, through the login's password-less sudo.
 *
 * ssh2 builds its SFTP object from the channel type when the channel opens, and
 * only then asks the server for the `sftp` subsystem; a plain exec channel can
 * never become one. So the request is what changes: on this client, the
 * subsystem request for `sftp` goes out as an exec of `ROOT_SFTP_COMMAND`, and
 * the SFTP protocol then runs over the stdin/stdout of a root sftp-server
 * exactly as it does over the subsystem's.
 *
 * Every SFTP channel on the client becomes root, so the client must be one kept
 * for root sessions alone, never shared with a login's. It reaches ssh2's
 * protocol object, which is not public API: if a future ssh2 moves it, this
 * throws rather than quietly opening a session as the login.
 */
export function openRootSftp(client: Client): Promise<SFTPWrapper> {
    if (!rooted.has(client)) {
        const protocol = (client as unknown as { _protocol?: Partial<ChannelRequests> })._protocol;
        if (
            !protocol ||
            typeof protocol.subsystem !== "function" ||
            typeof protocol.exec !== "function"
        ) {
            return Promise.reject(new Error("root_sftp_unsupported"));
        }
        const subsystem = protocol.subsystem.bind(protocol);
        const exec = protocol.exec.bind(protocol);
        protocol.subsystem = (channel, name, wantReply) =>
            name === "sftp"
                ? exec(channel, ROOT_SFTP_COMMAND, wantReply)
                : subsystem(channel, name, wantReply);
        rooted.add(client);
    }
    return openSftp(client);
}
