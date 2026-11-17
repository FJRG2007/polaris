/**
 * The dashboard's side of the worker browser: watching it and steering it, by
 * dialling the container's listener (session-browser-mcp.ts) the way a
 * preview is dialled. The caller has already checked that the reader owns the
 * session; this adds the key the container answers to, which never leaves the
 * server.
 *
 * Server-only.
 */

import { Readable } from "node:stream";
import { browserKey } from "./session-browser-link";
import * as protocol from "./session-browser-protocol";
import { PreviewError, requestSession } from "./session-preview";

export type BrowserFailure = "gone" | "closed" | "agentDriving" | "noBrowser" | "refused" | "unreachable";

export class BrowserError extends Error {
    public constructor(public readonly failure: BrowserFailure) {
        super(failure);
    }
}

function failureOf(error: unknown): BrowserFailure {
    if (error instanceof BrowserError) return error.failure;
    if (error instanceof PreviewError) {
        if (error.failure === "gone") return "gone";
        // Nothing listening: the agent has not started its browser server.
        if (error.failure === "refused") return "closed";
    }
    return "unreachable";
}

function headers(sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${browserKey(sessionId)}`, ...extra };
}

/** The container's packet stream, passed through unchanged for the page to
 *  decode (`PacketReader`). Ends when `signal` aborts or the container stops. */
export async function openBrowserStream(sessionId: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const sent = await requestSession(sessionId, protocol.BROWSER_STREAM_PORT, {
        method: "GET",
        path: "/stream",
        headers: headers(sessionId),
        body: null,
        signal
    }).catch((error: unknown) => {
        throw new BrowserError(failureOf(error));
    });
    if (sent.response.statusCode !== 200) {
        sent.response.resume();
        throw new BrowserError("unreachable");
    }
    return Readable.toWeb(sent.response) as ReadableStream<Uint8Array>;
}

/** Relays one input event from the person, mapped to CDP here. */
export async function sendBrowserInput(
    sessionId: string,
    input: protocol.BrowserInput,
    signal: AbortSignal
): Promise<void> {
    const commands = protocol.inputToCdp(input);
    if (!commands) throw new BrowserError("refused");
    const body = JSON.stringify({ commands });
    const sent = await requestSession(sessionId, protocol.BROWSER_STREAM_PORT, {
        method: "POST",
        path: "/input",
        headers: headers(sessionId, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body))
        }),
        body: Readable.from([body]),
        signal
    }).catch((error: unknown) => {
        throw new BrowserError(failureOf(error));
    });
    const status = sent.response.statusCode ?? 0;
    const text = await new Promise<string>((resolve) => {
        let collected = "";
        sent.response.on("data", (chunk: Buffer) => {
            collected = (collected + chunk.toString("utf8")).slice(0, 1024);
        });
        sent.response.on("end", () => resolve(collected));
        sent.response.on("error", () => resolve(collected));
    });
    sent.done();
    if (status === 200) return;
    throw new BrowserError(inputFailure(status, text));
}

/** What the container's answer to an input means for the person. */
export function inputFailure(status: number, body: string): BrowserFailure {
    if (status === 409 && body.includes("agent-driving")) return "agentDriving";
    if (status === 409) return "noBrowser";
    if (status === 400) return "refused";
    return "unreachable";
}
