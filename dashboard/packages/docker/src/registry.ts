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
            return new DockerDriver(
                streamRpc(
                    sshTransport({
                        host: config.host,
                        port: config.port,
                        username: config.username,
                        privateKey,
                        passphrase: creds.passphrase,
                        knownHosts: readKey(env.POLARIS_SSH_KNOWN_HOSTS)
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
