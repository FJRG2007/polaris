/**
 * Minimal HTTP/1.1 client over an arbitrary duplex stream. The Docker Engine API
 * is HTTP over a byte stream (a unix socket, a TCP connection, or the stdio
 * bridge from `docker system dial-stdio` over SSH), so one small client serves
 * every transport. We send `Connection: close`, which lets us accumulate the
 * whole response to EOF and parse it once - no incremental header/body state
 * machine, and it matches the one-request-per-channel lifecycle the SSH bridge
 * wants. Requests that read a bounded body (list/info/stats?stream=false, a
 * tail-limited log, a finished exec) all use that path.
 *
 * `hijackOverStream` is the one exception: an interactive exec keeps the stream
 * open in both directions after the reply head, so there the head is consumed
 * and the raw duplex is handed back.
 */

import type { Duplex } from "node:stream";

export interface DockerHttpResponse {
    readonly status: number;
    /** Raw response bytes. Text callers read `body`; a log or an exec reply is
     *  binary-framed, so those read this instead. */
    readonly bytes: Buffer;
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

        stream.write(requestHead(request, ["Connection: close"]));
    });
}

/** The response head of a hijacked request, plus the still-open stream. Docker
 *  answers an upgrade with 101 (or 200 for an already-raw connection) and then
 *  hands the connection over verbatim in both directions, which is what an
 *  interactive exec needs. Any body bytes that arrived with the head are pushed
 *  back so the caller reads a stream that starts where the payload does. */
export interface DockerHijackedResponse {
    readonly status: number;
    readonly stream: Duplex;
}

export function hijackOverStream(stream: Duplex, request: DockerHttpRequest): Promise<DockerHijackedResponse> {
    return new Promise((resolve, reject) => {
        let head = Buffer.alloc(0);

        const onData = (chunk: Buffer): void => {
            head = Buffer.concat([head, chunk]);
            const separator = head.indexOf("\r\n\r\n");
            if (separator === -1) {
                // A reply head this long is not one Docker sends; stop reading
                // rather than buffering whatever is on the other end.
                if (head.length > 64 * 1024) finish(new Error("Malformed HTTP response from Docker"));
                return;
            }
            const status = Number.parseInt(
                head.subarray(0, separator).toString("utf8").split("\r\n")[0]?.split(" ")[1] ?? "0",
                10
            );
            const rest = head.subarray(separator + 4);
            cleanup();
            if (rest.length > 0) stream.unshift(rest);
            resolve({ status, stream });
        };
        const onError = (error: Error): void => finish(error);
        const onEnd = (): void => finish(new Error("Docker closed the connection before replying"));

        function cleanup(): void {
            stream.off("data", onData);
            stream.off("error", onError);
            stream.off("end", onEnd);
        }
        function finish(error: Error): void {
            cleanup();
            stream.destroy();
            reject(error);
        }

        stream.on("data", onData);
        stream.on("error", onError);
        stream.on("end", onEnd);

        stream.write(requestHead(request, ["Connection: Upgrade", "Upgrade: tcp"]));
    });
}

/** Serialize a request line, its headers and its body into the bytes to write. */
function requestHead(request: DockerHttpRequest, connection: string[]): string {
    const headers = [`${request.method} ${request.path} HTTP/1.1`, "Host: docker", ...connection, "Accept: application/json"];
    if (request.body !== undefined) {
        headers.push("Content-Type: application/json");
        headers.push(`Content-Length: ${Buffer.byteLength(request.body)}`);
    }
    return `${headers.join("\r\n")}\r\n\r\n${request.body ?? ""}`;
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
    return { status, bytes: body, body: body.toString("utf8") };
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
