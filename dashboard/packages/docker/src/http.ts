/**
 * Minimal HTTP/1.1 client over an arbitrary duplex stream. The Docker Engine API
 * is HTTP over a byte stream (a unix socket, a TCP connection, or the stdio
 * bridge from `docker system dial-stdio` over SSH), so one small client serves
 * every transport. We send `Connection: close`, which lets us accumulate the
 * whole response to EOF and parse it once - no incremental header/body state
 * machine, and it matches the one-request-per-channel lifecycle the SSH bridge
 * wants. Only non-streaming endpoints are used (list/info/df/stats?stream=false),
 * so a single buffered response is always appropriate.
 */

import type { Duplex } from "node:stream";

export interface DockerHttpResponse {
    readonly status: number;
    readonly body: string;
}

export interface DockerHttpRequest {
    readonly method: string;
    readonly path: string;
    readonly body?: string;
}

/** Send one request over an already-connected stream and read the full reply. */
export function httpOverStream(stream: Duplex, request: DockerHttpRequest): Promise<DockerHttpResponse> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
            try {
                resolve(parseResponse(Buffer.concat(chunks)));
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });

        const headers = [
            `${request.method} ${request.path} HTTP/1.1`,
            "Host: docker",
            "Connection: close",
            "Accept: application/json"
        ];
        if (request.body !== undefined) {
            headers.push("Content-Type: application/json");
            headers.push(`Content-Length: ${Buffer.byteLength(request.body)}`);
        }
        stream.write(`${headers.join("\r\n")}\r\n\r\n${request.body ?? ""}`);
    });
}

function parseResponse(buffer: Buffer): DockerHttpResponse {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator === -1) throw new Error("Malformed HTTP response from Docker");
    const head = buffer.subarray(0, separator).toString("utf8");
    const lines = head.split("\r\n");
    const status = Number.parseInt(lines[0]?.split(" ")[1] ?? "0", 10);

    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }

    let body = buffer.subarray(separator + 4);
    if ((headers.get("transfer-encoding") ?? "").includes("chunked")) {
        body = decodeChunked(body);
    }
    return { status, body: body.toString("utf8") };
}

/** Decode HTTP chunked transfer encoding into the raw body bytes. */
function decodeChunked(input: Buffer): Buffer {
    const out: Buffer[] = [];
    let offset = 0;
    while (offset < input.length) {
        const lineEnd = input.indexOf("\r\n", offset);
        if (lineEnd === -1) break;
        const size = Number.parseInt(input.subarray(offset, lineEnd).toString("ascii").trim(), 16);
        if (!Number.isFinite(size) || size === 0) break;
        const start = lineEnd + 2;
        out.push(input.subarray(start, start + size));
        offset = start + size + 2;
    }
    return Buffer.concat(out);
}
