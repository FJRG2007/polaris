/**
 * A DockerRpc performs one Docker Engine API request and returns the status and
 * raw body. It is the single seam the driver depends on, so the same driver
 * serves both a direct byte-stream transport (socket/ssh/tcp) and an indirect
 * proxy: the local host is reached through polaris-hostd, which forwards only an
 * allowlisted set of calls and never exposes the socket to the web container.
 *
 * `hijack` is optional for exactly that reason. A byte-stream transport can hand
 * an interactive exec its raw connection; the daemon proxy answers one bounded
 * request at a time and has its own exec endpoint instead. A caller that needs a
 * duplex checks for the method rather than assuming every connection has one.
 */

import type { DockerTransportConn } from "./transports.js";
import { hijackOverStream, httpOverStream, type DockerHijackedResponse } from "./http.js";

export interface DockerRpcResponse {
    readonly status: number;
    readonly bytes: Buffer;
    readonly body: string;
}

export interface DockerRpc {
    /** Perform one request and read the full reply. */
    request(method: string, path: string, body?: string): Promise<DockerRpcResponse>;
    /** Perform one request and keep the stream open in both directions. */
    hijack?(method: string, path: string, body?: string): Promise<DockerHijackedResponse>;
    /** Release any transport-level resources (idempotent). */
    dispose(): Promise<void>;
}

/**
 * Wrap a byte-stream transport as a DockerRpc: each request opens a fresh stream
 * and speaks Docker HTTP directly over it. Used for socket, SSH, and TCP hosts.
 */
export function streamRpc(conn: DockerTransportConn): DockerRpc {
    return {
        request: async (method, path, body) => httpOverStream(await conn.stream(), { method, path, body }),
        hijack: async (method, path, body) => hijackOverStream(await conn.stream(), { method, path, body }),
        dispose: () => conn.close()
    };
}
