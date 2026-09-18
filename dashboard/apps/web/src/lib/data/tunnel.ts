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
}

/** A tunnel that could not be opened, in words the reader can act on. */
export class TunnelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TunnelError";
    }
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
    if (!tunnel.jump) return [await deps.connect(tunnel.target)];
    const jump = await deps.connect(tunnel.jump);
    try {
        const stream = await deps.forward(jump, tunnel.target.host, tunnel.target.port);
        const target = await deps.connect({ ...tunnel.target, sock: stream });
        return [target, jump];
    } catch (error) {
        jump.end();
        throw error;
    }
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
        console.error("databases: the SSH tunnel did not open", error);
        throw new TunnelError(
            `Polaris could not open the SSH tunnel through ${tunnel.label}. Check that the server is up and that the login still works.`
        );
    }
    const endAll = () => {
        for (const client of clients) client.end();
    };
    try {
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
    deps: TunnelDeps = REAL
): Promise<string> {
    let presented: string | undefined;
    let clients: Client[];
    try {
        clients = await connectTunnel(
            {
                target: {
                    ...target,
                    onHostKey: (key) => {
                        presented = key;
                    }
                },
                jump,
                label: target.host
            },
            deps
        );
    } catch (error) {
        if (presented !== undefined && !hostKeyAccepted(presented, target.pinnedHostKey)) {
            throw new TunnelError(
                `${target.host}:${target.port} answered with a different key than the one Polaris pinned for this connection, so nothing was sent to it. If that server was rebuilt, remove this connection and add it again.`
            );
        }
        throw error;
    }
    for (const client of clients) client.end();
    if (!presented) throw new Error("Connected but never received a host key");
    return presented;
}
