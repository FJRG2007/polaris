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
import { Client } from "ssh2";

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
    readonly privateKey: string | Buffer;
    readonly passphrase?: string;
    /** Contents of a known_hosts file used to pin the server's host key. */
    readonly knownHosts: string;
}

export function sshTransport(options: SshTransportOptions): DockerTransportConn {
    const pinned = pinnedKeysFor(options.knownHosts, options.host, options.port);
    let client: Client | undefined;

    async function ensureClient(): Promise<Client> {
        if (client) return client;
        const conn = new Client();
        await new Promise<void>((resolve, reject) => {
            conn.on("ready", () => resolve());
            conn.on("error", reject);
            conn.connect({
                host: options.host,
                port: options.port,
                username: options.username,
                privateKey: options.privateKey,
                passphrase: options.passphrase,
                hostVerifier: (key: Buffer) => pinned.has(key.toString("base64"))
            });
        });
        client = conn;
        return conn;
    }

    return {
        stream: async () => {
            if (pinned.size === 0) {
                throw new Error("Refusing SSH: no pinned host key (known_hosts is empty)");
            }
            const conn = await ensureClient();
            return new Promise<Duplex>((resolve, reject) => {
                // The command is ignored when the key is locked to a forced
                // command; it is the correct command for unlocked remote hosts.
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

/** Base64 host keys pinned for a host (and its [host]:port form) in known_hosts. */
function pinnedKeysFor(knownHosts: string, host: string, port: number): Set<string> {
    const aliases = new Set([host, `[${host}]:${port}`]);
    const keys = new Set<string>();
    for (const line of knownHosts.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const [hostField, , keyField] = trimmed.split(/\s+/);
        if (hostField && keyField && hostField.split(",").some((entry) => aliases.has(entry))) {
            keys.add(keyField);
        }
    }
    return keys;
}
