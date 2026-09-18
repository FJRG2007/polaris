/**
 * A port on this machine's loopback that leads to an address only an SSH server
 * can see.
 *
 * SSH carries arbitrary TCP inside the connection (a `direct-tcpip` channel), so
 * anything that dials a host and a port - an HTTP client, a database driver - can
 * be pointed at `127.0.0.1:<port>` here and reach the far side without knowing a
 * tunnel is involved. One channel per accepted socket, and either end closing
 * takes the other with it.
 *
 * Loopback only: this is a door into another network, and not one to leave open
 * to the machine's own LAN.
 *
 * Here rather than in an app because two of them need it and neither owns it:
 * the camera relay reaches a house's own network this way, and a database
 * connection reaches an engine that publishes nothing. It is the same channel
 * `forwardOut` opens, with a listener in front of it.
 *
 * Server-only.
 */

import type { Client } from "ssh2";
import { forwardOut } from "./exec.js";
import { createServer, type Server, type Socket } from "node:net";

export interface LocalForward {
    /** Always the loopback address. */
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly server: Server;
    /** How many sockets are passing through right now. */
    readonly live: () => number;
    /** Stop listening and drop every socket still open. The SSH client is the
     *  caller's to end. */
    close(): void;
}

export async function listenForward(
    client: Client,
    remoteHost: string,
    remotePort: number,
    onActivity?: () => void
): Promise<LocalForward> {
    const server = createServer();
    const sockets = new Set<Socket>();

    server.on("connection", (socket: Socket) => {
        sockets.add(socket);
        onActivity?.();
        socket.on("close", () => {
            sockets.delete(socket);
            onActivity?.();
        });
        socket.on("error", () => socket.destroy());
        void forwardOut(client, remoteHost, remotePort)
            .then((channel) => {
                if (socket.destroyed) {
                    channel.close();
                    return;
                }
                socket.pipe(channel).pipe(socket);
                channel.on("error", () => socket.destroy());
                channel.on("close", () => socket.destroy());
                socket.on("close", () => channel.close());
            })
            .catch(() => socket.destroy());
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address && typeof address === "object") resolve(address.port);
            else reject(new Error("The tunnel could not be opened"));
        });
    });

    return {
        host: "127.0.0.1",
        port,
        server,
        live: () => sockets.size,
        close() {
            server.close();
            for (const socket of sockets) socket.destroy();
            sockets.clear();
        }
    };
}
