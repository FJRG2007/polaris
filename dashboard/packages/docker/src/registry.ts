/**
 * Build a Docker driver from a stored connection. Transport wiring lives here so
 * the app only deals in connections, never in sockets and keys. The common local
 * case (SSH with the install-provisioned key) reads the mounted key and pinned
 * known_hosts from the environment; a remote host may instead carry its own
 * pasted key. Missing key/known_hosts fail closed rather than connecting blind.
 */

import { readFileSync } from "node:fs";
import { loadEnv } from "@polaris/config";
import { DockerDriver } from "./driver.js";
import { streamRpc } from "./rpc.js";
import type { DockerConfig, DockerCredentials } from "./schema.js";
import { socketTransport, sshTransport, tcpTransport } from "./transports.js";

export interface DockerConnectionRecord {
    readonly id: string;
    readonly config: DockerConfig;
    readonly credentials: DockerCredentials;
}

export function createDockerDriver(record: DockerConnectionRecord): DockerDriver {
    const config = record.config;
    switch (config.transport) {
        case "socket":
            return new DockerDriver(streamRpc(socketTransport(config.socketPath)));
        case "tcp": {
            const creds = record.credentials as Extract<DockerCredentials, { transport: "tcp" }>;
            return new DockerDriver(
                streamRpc(
                    tcpTransport({
                        host: config.host,
                        port: config.port,
                        tls: config.tls,
                        ca: creds.ca,
                        cert: creds.cert,
                        key: creds.key
                    })
                )
            );
        }
        case "ssh": {
            const env = loadEnv();
            const creds = record.credentials as Extract<DockerCredentials, { transport: "ssh" }>;
            const privateKey = config.useInstallKey
                ? readKey(env.POLARIS_SSH_KEY)
                : creds.privateKey ?? "";
            if (!privateKey) throw new Error("SSH connection has no private key");
            const pinnedHostKey = firstPinnedKey(
                readKey(env.POLARIS_SSH_KNOWN_HOSTS),
                config.host,
                config.port
            );
            return new DockerDriver(
                streamRpc(
                    sshTransport({
                        host: config.host,
                        port: config.port,
                        username: config.username,
                        auth: { method: "key", privateKey, passphrase: creds.passphrase },
                        pinnedHostKey
                    })
                )
            );
        }
    }
}

function readKey(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        throw new Error(`Cannot read ${path}; is SSH docker access provisioned?`);
    }
}

/** First base64 host key pinned for a host (or its [host]:port form) in a
 *  known_hosts file, if any. The shared SSH client compares the server key in
 *  the same base64 encoding. */
function firstPinnedKey(knownHosts: string, host: string, port: number): string | undefined {
    const aliases = new Set([host, `[${host}]:${port}`]);
    for (const line of knownHosts.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const [hostField, , keyField] = trimmed.split(/\s+/);
        if (hostField && keyField && hostField.split(",").some((entry) => aliases.has(entry))) {
            return keyField;
        }
    }
    return undefined;
}
