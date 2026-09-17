/**
 * Reaching a port that only one of your machines can see.
 *
 * A camera on another network is reached by a server that lives there, and that
 * server runs the relay. Which leaves one problem: Polaris has to reach the
 * relay, and the relay answers on a high port that nobody forwards. Asking
 * somebody to forward a second port on a router they already had to touch once
 * is where a feature stops being used.
 *
 * So the stream comes back down the connection Polaris already has. SSH carries
 * arbitrary TCP inside it (a `direct-tcpip` channel is exactly this), and Polaris
 * is already connected to that machine, with its host key pinned, to run
 * everything else. A listener on the loopback interface here forwards into that
 * channel, and the rest of Polaris dials `http://127.0.0.1:<port>` without
 * knowing any of it happened.
 *
 * One tunnel per (server, port), reused, and closed when nothing has used it for
 * a while: a house with one remote camera holds one SSH connection, not one per
 * viewer.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { listenForward, openSshClient, type Client, type LocalForward } from "@polaris/ssh";

const { getHostConnection } = host.hostService;

/** How long a tunnel with nothing going through it is kept before it is closed.
 *  Long enough that watching a camera, closing the tab and opening it again does
 *  not pay for a new SSH handshake. */
const IDLE_MS = 10 * 60_000;

/** How often idle tunnels are looked for. */
const REAP_MS = 60_000;

interface Tunnel {
    readonly url: string;
    /** The loopback listener. Its open sockets are what keeps a tunnel in use
     *  from being reaped mid-stream. */
    readonly forward: LocalForward;
    readonly client: Client;
    lastUsed: number;
}

const tunnels = new Map<string, Promise<Tunnel>>();
let reaper: NodeJS.Timeout | null = null;

function keyFor(hostId: string, remoteHost: string, remotePort: number): string {
    return `${hostId}:${remoteHost}:${remotePort}`;
}

/** Close a tunnel and forget it, whatever state it is in. */
async function close(key: string): Promise<void> {
    const pending = tunnels.get(key);
    tunnels.delete(key);
    if (!pending) return;
    const tunnel = await pending.catch(() => null);
    if (!tunnel) return;
    tunnel.forward.close();
    tunnel.client.end();
}

/** Drop the tunnels nothing has used lately. Started with the first tunnel, so
 *  an instance with no remote cameras never has a timer at all. */
function startReaper(): void {
    if (reaper) return;
    reaper = setInterval(() => {
        void (async () => {
            for (const [key, pending] of tunnels) {
                const tunnel = await pending.catch(() => null);
                if (!tunnel) {
                    tunnels.delete(key);
                    continue;
                }
                if (tunnel.forward.live() === 0 && Date.now() - tunnel.lastUsed > IDLE_MS) await close(key);
            }
            if (tunnels.size === 0 && reaper) {
                clearInterval(reaper);
                reaper = null;
            }
        })();
    }, REAP_MS);
    reaper.unref?.();
}

async function open(
    hostId: string,
    ownerId: string,
    remoteHost: string,
    remotePort: number
): Promise<Tunnel> {
    const connection = await getHostConnection(hostId, ownerId);
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        ...(connection.hostKey ? { pinnedHostKey: connection.hostKey } : {})
    });

    // The connection dying takes the listener with it, so the next request builds
    // a fresh one rather than dialling a port that forwards nowhere.
    const key = keyFor(hostId, remoteHost, remotePort);
    client.on("error", () => void close(key));
    client.on("close", () => void close(key));

    let forward: LocalForward;
    try {
        forward = await listenForward(client, remoteHost, remotePort, () => {
            tunnel.lastUsed = Date.now();
        });
    } catch (error) {
        client.end();
        throw error;
    }
    const tunnel: Tunnel = {
        url: `http://127.0.0.1:${forward.port}`,
        forward,
        client,
        lastUsed: Date.now()
    };

    startReaper();
    return tunnel;
}

/**
 * A local address that reaches `remoteHost:remotePort` from the named server.
 *
 * Idempotent per (server, host, port): callers ask every time and get the same
 * tunnel back. Throws if the server cannot be connected to at all, which is the
 * one failure worth surfacing - it means Polaris has no way to that network and
 * nothing further will work either.
 */
export async function tunnelledUrl(
    hostId: string,
    ownerId: string,
    remoteHost: string,
    remotePort: number
): Promise<string> {
    const key = keyFor(hostId, remoteHost, remotePort);
    const existing = tunnels.get(key);
    if (existing) {
        const tunnel = await existing.catch(() => null);
        if (tunnel) {
            tunnel.lastUsed = Date.now();
            return tunnel.url;
        }
        tunnels.delete(key);
    }
    const pending = open(hostId, ownerId, remoteHost, remotePort);
    tunnels.set(key, pending);
    try {
        return (await pending).url;
    } catch (error) {
        tunnels.delete(key);
        throw error;
    }
}

/** Drop every tunnel to one server - after its credentials change, or when it is
 *  removed. */
export async function closeTunnelsTo(hostId: string): Promise<void> {
    for (const key of [...tunnels.keys()]) {
        if (key.startsWith(`${hostId}:`)) await close(key);
    }
}
