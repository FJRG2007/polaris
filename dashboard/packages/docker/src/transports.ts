/**
 * Transports open a fresh byte stream to a Docker Engine API endpoint. Each
 * transport returns a duplex per request (the HTTP client sends Connection:
 * close), so there is no shared HTTP state to manage. The SSH transport keeps one
 * ssh2 connection and opens an exec channel per request; the host's forced
 * command bridges that channel to the docker socket via `docker system
 * dial-stdio`. Host keys are pinned - an unpinned or mismatched host is refused,
 * never trusted on first sight.
 */

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { openSshClient, type SshAuth } from "@polaris/ssh";
import type { Client } from "ssh2";

export interface DockerTransportConn {
    /** Open a fresh HTTP-capable stream to the Docker API. */
    stream(): Promise<Duplex>;
    close(): Promise<void>;
}

export function socketTransport(socketPath: string): DockerTransportConn {
    return {
        stream: async () => netConnect(socketPath),
        close: async () => undefined
    };
}

export interface TcpTransportOptions {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
    readonly ca?: string;
    readonly cert?: string;
    readonly key?: string;
}

export function tcpTransport(options: TcpTransportOptions): DockerTransportConn {
    return {
        stream: async () =>
            options.tls
                ? tlsConnect({
                      host: options.host,
                      port: options.port,
                      ca: options.ca,
                      cert: options.cert,
                      key: options.key
                  })
                : netConnect(options.port, options.host),
        close: async () => undefined
    };
}

export interface SshTransportOptions {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly auth: SshAuth;
    /** Pinned server public key(s), base64. SSH is refused without at least one. */
    readonly pinnedHostKey?: string | string[];
}

export function sshTransport(options: SshTransportOptions): DockerTransportConn {
    let client: Client | undefined;

    async function ensureClient(): Promise<Client> {
        if (client) return client;
        const pins = options.pinnedHostKey;
        if (!pins || (Array.isArray(pins) && pins.length === 0)) {
            throw new Error("Refusing SSH: no pinned host key");
        }
        client = await openSshClient({
            host: options.host,
            port: options.port,
            username: options.username,
            auth: options.auth,
            pinnedHostKey: options.pinnedHostKey
        });
        return client;
    }

    return {
        stream: async () => {
            const conn = await ensureClient();
            return new Promise<Duplex>((resolve, reject) => {
                // Ignored when the install key is locked to a forced command; the
                // correct command for an unlocked remote host or a global Host.
                conn.exec("docker system dial-stdio", (error, channel) => {
                    if (error) reject(error);
                    else resolve(channel);
                });
            });
        },
        close: async () => {
            client?.end();
            client = undefined;
        }
    };
}
