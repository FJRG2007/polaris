/**
 * One HTTP/1.1 exchange over a stream Polaris already has open.
 *
 * A mail server on another machine is managed through an SSH channel forwarded
 * to its own loopback, so the administrator's password never crosses the network
 * in the clear and the management port never has to be reachable from anywhere
 * else. That channel is a byte stream, not a socket `fetch` knows how to use -
 * so the request is written and the answer read here, by hand, which for a few
 * kilobytes of JSON with `Connection: close` is a handful of lines.
 *
 * The parser is exported on its own so it is tested without a network.
 */

import type { Duplex } from "node:stream";

export interface HttpExchange {
    readonly method: string;
    readonly path: string;
    readonly host: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
}

export interface HttpAnswer {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    /** The body as text, which is what every management answer is. */
    readonly body: string;
    /** The same body as it arrived, for a download. */
    readonly bytes: Buffer;
}

/** The most of an answer this reads. Management answers are small; past this
 *  it is not a management answer. */
const MAX_ANSWER = 8 * 1024 * 1024;

/** How long one exchange may take. */
const EXCHANGE_TIMEOUT_MS = 20_000;

/** Nothing that could end a header line or start another may reach one. */
function headerSafe(value: string): string {
    if (/[\r\n]/.test(value)) throw new Error("a header value cannot contain a line break");
    return value;
}

/** The request as bytes. */
export function serializeRequest(request: HttpExchange): Buffer {
    const body = request.body !== undefined ? Buffer.from(request.body, "utf8") : null;
    const lines = [
        `${headerSafe(request.method)} ${headerSafe(request.path)} HTTP/1.1`,
        `Host: ${headerSafe(request.host)}`
    ];
    for (const [name, value] of Object.entries(request.headers))
        lines.push(`${headerSafe(name)}: ${headerSafe(value)}`);
    lines.push("Connection: close");
    if (body) lines.push(`Content-Length: ${body.length}`);
    return Buffer.concat([
        Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"),
        body ?? Buffer.alloc(0)
    ]);
}

/** Decode a chunked body. Stops at the zero chunk or at data that is not one. */
function dechunk(input: Buffer): Buffer {
    const out: Buffer[] = [];
    let offset = 0;
    while (offset < input.length) {
        const lineEnd = input.indexOf("\r\n", offset);
        if (lineEnd < 0) break;
        const size = Number.parseInt(
            input.subarray(offset, lineEnd).toString("latin1").split(";")[0] ?? "",
            16
        );
        if (!Number.isFinite(size) || size <= 0) break;
        const start = lineEnd + 2;
        out.push(input.subarray(start, Math.min(start + size, input.length)));
        offset = start + size + 2;
    }
    return Buffer.concat(out);
}

/** Read a whole response. Throws on anything that is not one. */
export function parseHttpResponse(raw: Buffer): HttpAnswer {
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) throw new Error("the server's answer ended before its headers did");
    const head = raw.subarray(0, split).toString("latin1").split("\r\n");
    const status = Number(head[0]?.split(" ")[1]);
    if (!Number.isInteger(status)) throw new Error("the server's answer had no status");
    const headers: Record<string, string> = {};
    for (const line of head.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0)
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    let body = raw.subarray(split + 4);
    if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked"))
        body = dechunk(body);
    else if (headers["content-length"] !== undefined) {
        const length = Number(headers["content-length"]);
        if (Number.isFinite(length)) body = body.subarray(0, length);
    }
    return { status, headers, body: body.toString("utf8"), bytes: body };
}

/** Send one request down a stream and read the answer until the far side closes. */
export function exchangeOverStream(stream: Duplex, request: HttpExchange): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (outcome: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream.removeAllListeners("data");
            outcome();
        };
        const timer = setTimeout(() => {
            finish(() => reject(new Error("the mail server did not answer in time")));
            stream.destroy();
        }, EXCHANGE_TIMEOUT_MS);
        stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ANSWER) {
                finish(() =>
                    reject(
                        new Error("the mail server's answer was larger than any management answer")
                    )
                );
                stream.destroy();
                return;
            }
            chunks.push(chunk);
        });
        stream.on("error", (error: Error) => finish(() => reject(error)));
        stream.on("close", () =>
            finish(() => {
                try {
                    resolve(parseHttpResponse(Buffer.concat(chunks)));
                } catch (error) {
                    reject(error);
                }
            })
        );
        stream.write(serializeRequest(request));
    });
}
