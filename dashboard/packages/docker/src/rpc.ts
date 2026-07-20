/**
 * A DockerRpc performs one Docker Engine API request and returns the status and
 * raw body. It is the single seam the driver depends on, so the same driver
 * serves both a direct byte-stream transport (socket/ssh/tcp) and an indirect
 * proxy: the local host is reached through polaris-hostd, which forwards only an
 * allowlisted set of calls and never exposes the socket to the web container.
 */

import { httpOverStream } from "./http.js";
import type { DockerTransportConn } from "./transports.js";

export interface DockerRpcResponse {
    readonly status: number;
    readonly body: string;
}

export interface DockerRpc {
    /** Perform one request and read the full reply. */
    request(method: string, path: string): Promise<DockerRpcResponse>;
    /** Release any transport-level resources (idempotent). */
    dispose(): Promise<void>;
}

/**
 * Wrap a byte-stream transport as a DockerRpc: each request opens a fresh stream
 * and speaks Docker HTTP directly over it. Used for socket, SSH, and TCP hosts.
 */
export function streamRpc(conn: DockerTransportConn): DockerRpc {
    return {
        request: async (method, path) => httpOverStream(await conn.stream(), { method, path }),
        dispose: () => conn.close()
    };
}
