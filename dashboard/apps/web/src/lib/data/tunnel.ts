/**
 * Reaching a database through SSH, the way a desktop client does.
 *
 * The database's host and port are as the SSH server sees them - usually
 * `127.0.0.1` and the engine's port on a machine that publishes nothing. A
 * loopback port here is forwarded to that address over the SSH connection (see
 * `listenForward`), and the driver is pointed at the loopback port without
 * knowing a tunnel is involved.
 *
 * Opened for one call and closed after it, like the driver connection itself
 * (see `driver.ts`): a tunnel held across requests would be a live way into
 * somebody's network after the credential behind it was changed.
 *
 * Every SSH login here is pinned. A registered server carries the key captured
 * when it was added; a login typed into the connection form has its key captured
 * when the connection is saved, and a connection without one is refused rather
 * than opened on trust.
 *
 * Server-only.
 */

import type { Client } from "ssh2";
import { createHash } from "node:crypto";
import {
    forwardOut,
    hostKeyAccepted,
    listenForward,
    openSshClient,
    type SshConnectOptions
} from "@polaris/ssh";

/** A resolved tunnel: every login it needs, secrets included. Never logged, never
 *  returned to a browser. */
export interface DataTunnel {
    /** The SSH server the database is reached from. */
    readonly target: SshConnectOptions;
    /** A registered server the target is reached through, when there is one. */
    readonly jump: SshConnectOptions | null;
    /** How to name the SSH server in a sentence, without its credentials. */
    readonly label: string;
    /** How to name the jump server in a sentence. */
    readonly jumpLabel?: string;
}

/** A tunnel that could not be opened, in words the reader can act on. */
export class TunnelError extends Error {
    constructor(
        message: string,
        /** Set when the cause was an SSH server presenting a key other than the
         *  pinned one: which hop, and the key it presented. */
        readonly keyChanged: { readonly hop: "target" | "jump"; readonly presented: string } | null = null
    ) {
        super(message);
        this.name = "TunnelError";
    }
}

/** The sentences a changed key is said in. Matched back to the catalog by
 *  `lib/data/words`. */
export const KEY_CHANGED = {
    target: (where: string) =>
        `${where} answered with a different SSH key than the one pinned for this connection, so nothing was sent to it. If that server was rebuilt, check the new key in the connection's settings and trust it there.`,
    jump: (server: string) =>
        `${server} answered with a different SSH key than the one Polaris has on record for it, so nothing was sent to it. Check that server under Servers.`
} as const;

/** The sentences a forward the SSH server turned down is said in. Matched back
 *  to the catalog by `lib/data/words`. */
export const FORWARD_REFUSED = {
    prohibited: (server: string) =>
        `${server} does not allow port forwarding for this SSH login, so the database cannot be reached through it. Allow TCP forwarding for that user in the server's SSH settings.`,
    unreachable: (server: string, where: string) =>
        `${server} could not reach the database at ${where}. Check that the database is running and listening on that address.`
} as const;

const tunnelFailed = (server: string) =>
    `Polaris could not open the SSH tunnel through ${server}. Check that the server is up and that the login still works.`;

/** ssh2's `reason` on a refused channel: RFC 4254's open failure codes. */
const ADMINISTRATIVELY_PROHIBITED = 1;
const CONNECT_FAILED = 2;

/**
 * A host key the way OpenSSH prints one: "SHA256:" and the unpadded base64 of
 * the SHA-256 of the key blob. What a reader compares against `ssh-keygen -lf`
 * on the server, or against what their own client showed them.
 */
export function sshFingerprint(hostKey: string): string {
    const digest = createHash("sha256").update(Buffer.from(hostKey, "base64")).digest("base64");
    return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Wrap a hop's options so the key it presents is remembered, whatever happens. */
function watched(options: SshConnectOptions): {
    options: SshConnectOptions;
    presented: () => string | undefined;
} {
    let presented: string | undefined;
    return {
        options: {
            ...options,
            onHostKey: (key) => {
                presented = key;
                options.onHostKey?.(key);
            }
        },
        presented: () => presented
    };
}

/** Whether a hop failed because its key was not the pinned one. */
function keyRefused(options: SshConnectOptions, presented: string | undefined): presented is string {
    return (
        presented !== undefined &&
        options.pinnedHostKey !== undefined &&
        !hostKeyAccepted(presented, options.pinnedHostKey)
    );
}

/** How the pieces of the SSH side are opened. Swapped in tests. */
export interface TunnelDeps {
    readonly connect: (options: SshConnectOptions) => Promise<Client>;
    readonly forward: typeof forwardOut;
}

const REAL: TunnelDeps = { connect: openSshClient, forward: forwardOut };

/**
 * The SSH connection to the target, through the jump server when there is one.
 * Returns every client opened, in the order they must be closed.
 */
export async function connectTunnel(
    tunnel: DataTunnel,
    deps: TunnelDeps = REAL
): Promise<Client[]> {
    const target = watched(tunnel.target);
    const failed = (error: unknown): never => {
        const presented = target.presented();
        if (keyRefused(tunnel.target, presented)) {
            throw new TunnelError(KEY_CHANGED.target(tunnel.label), { hop: "target", presented });
        }
        throw error;
    };

    const bastion = tunnel.jump;
    if (!bastion) return [await deps.connect(target.options).catch(failed)];

    const hop = watched(bastion);
    const jump = await deps.connect(hop.options).catch((error: unknown) => {
        const presented = hop.presented();
        if (keyRefused(bastion, presented)) {
            throw new TunnelError(KEY_CHANGED.jump(tunnel.jumpLabel ?? bastion.host), {
                hop: "jump",
                presented
            });
        }
        throw error;
    });
    try {
        const stream = await deps.forward(jump, tunnel.target.host, tunnel.target.port);
        const reached = await deps.connect({ ...target.options, sock: stream }).catch(failed);
        return [reached, jump];
    } catch (error) {
        jump.end();
        throw error;
    }
}

function forwardRefusal(error: unknown, server: string, host: string, port: number): TunnelError {
    const reason = (error as { reason?: unknown } | null)?.reason;
    if (reason === ADMINISTRATIVELY_PROHIBITED) return new TunnelError(FORWARD_REFUSED.prohibited(server));
    if (reason === CONNECT_FAILED) return new TunnelError(FORWARD_REFUSED.unreachable(server, `${host}:${port}`));
    console.error("databases: the SSH server did not forward to the database", error);
    return new TunnelError(tunnelFailed(server));
}

export interface OpenTunnel {
    readonly host: "127.0.0.1";
    readonly port: number;
    close(): void;
}

/**
 * A loopback port leading to `remoteHost:remotePort` as the tunnel's SSH server
 * sees it. Close it when the call is done.
 */
export async function openTunnel(
    tunnel: DataTunnel,
    remoteHost: string,
    remotePort: number,
    deps: TunnelDeps = REAL
): Promise<OpenTunnel> {
    let clients: Client[];
    try {
        clients = await connectTunnel(tunnel, deps);
    } catch (error) {
        // A changed key is said as itself: it is the one failure here that is
        // not "check the server is up", and the reader has something to do.
        if (error instanceof TunnelError) throw error;
        console.error("databases: the SSH tunnel did not open", error);
        throw new TunnelError(tunnelFailed(tunnel.label));
    }
    const endAll = () => {
        for (const client of clients) client.end();
    };
    try {
        const channel = await deps.forward(clients[0]!, remoteHost, remotePort).catch((error: unknown) => {
            throw forwardRefusal(error, tunnel.label, remoteHost, remotePort);
        });
        channel.close();
        const forward = await listenForward(clients[0]!, remoteHost, remotePort);
        return {
            host: forward.host,
            port: forward.port,
            close() {
                forward.close();
                endAll();
            }
        };
    } catch (error) {
        endAll();
        throw error;
    }
}

/**
 * Sign in to a tunnel's SSH server once and return the key it presented, to pin
 * for every later connection. Through the jump server when there is one.
 *
 * `pinnedHostKey` is what is already on record for this login, and is left out
 * only the first time one is saved. It is what makes a re-save safe: the verifier
 * runs before the credential is sent, so a login typed again - a rotated
 * password, a switch from a password to a key - is offered to the server whose
 * key was pinned rather than to whatever answers at that address.
 */
export async function captureHostKey(
    target: Omit<SshConnectOptions, "onHostKey" | "sock">,
    jump: SshConnectOptions | null,
    deps: TunnelDeps = REAL,
    jumpLabel: string | null = null
): Promise<string> {
    let presented: string | undefined;
    const clients = await connectTunnel(
        {
            target: {
                ...target,
                onHostKey: (key) => {
                    presented = key;
                }
            },
            jump,
            label: `${target.host}:${target.port}`,
            ...(jumpLabel ? { jumpLabel } : {})
        },
        deps
    );
    for (const client of clients) client.end();
    if (!presented) throw new Error("Connected but never received a host key");
    return presented;
}

/**
 * The key an SSH server presents right now, read without signing in.
 *
 * The verifier refuses every key, so the handshake stops at the point the key
 * is shown and no credential is ever offered - the read a reader needs before
 * deciding whether to trust a key that changed. A jump server, when there is
 * one, is still signed in to and still checked against its own pin.
 */
export async function presentedHostKey(
    target: Pick<SshConnectOptions, "host" | "port" | "username">,
    jump: SshConnectOptions | null,
    jumpLabel: string | null,
    deps: TunnelDeps = REAL
): Promise<string> {
    let presented: string | undefined;
    const probe: SshConnectOptions = {
        ...target,
        // Never sent: the verifier refuses every key, before authentication.
        auth: { method: "password", password: "" },
        pinnedHostKey: [],
        onHostKey: (key) => {
            presented = key;
        }
    };
    try {
        const clients = await connectTunnel(
            {
                target: probe,
                jump,
                label: `${target.host}:${target.port}`,
                ...(jumpLabel ? { jumpLabel } : {})
            },
            deps
        );
        for (const client of clients) client.end();
    } catch (error) {
        if (error instanceof TunnelError && error.keyChanged?.hop === "target") {
            return error.keyChanged.presented;
        }
        if (error instanceof TunnelError) throw error;
        if (presented) return presented;
        console.error("databases: could not read an SSH server's key", error);
        throw new TunnelError(
            `Polaris could not reach ${target.host}:${target.port} to read its key. Check that the server is up.`
        );
    }
    if (!presented) throw new Error("Connected but never received a host key");
    return presented;
}
