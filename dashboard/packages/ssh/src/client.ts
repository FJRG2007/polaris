/**
 * Shared SSH client. One place that opens an authenticated ssh2 connection with
 * mandatory host-key verification, so both connectors that need SSH - the Docker
 * connector (`docker system dial-stdio`) and the SFTP storage driver - behave
 * identically and neither reinvents auth or pinning.
 *
 * Host-key pinning: the verifier runs during the handshake, before any credential
 * is sent. A registered host carries a pinned key (base64 of the raw key blob);
 * a mismatch is refused. During "add host" no key is pinned yet, so the first key
 * is accepted once and reported via `onHostKey` for the caller to store.
 */

import { Client } from "ssh2";
import type { ConnectConfig } from "ssh2";

const DEFAULT_READY_TIMEOUT_MS = 15_000;

/** Auth material. `password` uses a password; `key` uses a private key with an
 *  optional passphrase for an encrypted key. */
export interface SshAuth {
    readonly method: "password" | "key";
    readonly password?: string;
    readonly privateKey?: string;
    readonly passphrase?: string;
}

export interface SshConnectOptions {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly auth: SshAuth;
    /** Pinned server public key (base64 of the raw key blob). When set, the
     *  server key MUST match. Omit only during trust-on-add. */
    readonly pinnedHostKey?: string;
    /** Invoked with the server's key (base64) as soon as it is presented. */
    readonly onHostKey?: (hostKey: string) => void;
    readonly readyTimeoutMs?: number;
}

/** Open an authenticated ssh2 client. Rejects if the host key does not match the
 *  pin, if auth fails, or on any transport error. The caller owns `client.end()`. */
export function openSshClient(options: SshConnectOptions): Promise<Client> {
    const client = new Client();
    return new Promise<Client>((resolve, reject) => {
        client.once("ready", () => resolve(client));
        client.once("error", (error) => reject(error));
        try {
            client.connect(buildConnectConfig(options));
        } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

/**
 * Validate credentials and capture the server's host key in one connect, then
 * close. Used by "add host" to trust-on-add: a successful return means the
 * credentials work and yields the key to pin for every later connection.
 */
export async function testAndCaptureHostKey(
    options: Omit<SshConnectOptions, "pinnedHostKey" | "onHostKey">
): Promise<string> {
    let captured: string | undefined;
    const client = await openSshClient({
        ...options,
        onHostKey: (key) => {
            captured = key;
        }
    });
    client.end();
    if (!captured) {
        // The verifier always fires during a successful handshake; a missing key
        // means something is wrong with the transport rather than the auth.
        throw new Error("Connected but never received a host key");
    }
    return captured;
}

function buildConnectConfig(options: SshConnectOptions): ConnectConfig {
    const config: ConnectConfig = {
        host: options.host,
        port: options.port,
        username: options.username,
        readyTimeout: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        hostVerifier: (key: Buffer): boolean => {
            const presented = key.toString("base64");
            options.onHostKey?.(presented);
            // Trust-on-add: no pin yet, accept once so the caller can capture it.
            if (!options.pinnedHostKey) return true;
            return presented === options.pinnedHostKey;
        }
    };

    if (options.auth.method === "password") {
        config.password = options.auth.password;
    } else {
        config.privateKey = options.auth.privateKey;
        if (options.auth.passphrase) config.passphrase = options.auth.passphrase;
    }
    return config;
}
