/**
 * Server-sent events, read from a byte stream.
 *
 * The parsing rules of the HTML standard's event stream: lines end in LF, CR or
 * CRLF; a blank line dispatches what was gathered; `data` lines join with a
 * newline; a line starting with a colon is a comment; `id` and `retry` carry
 * over to the frames after them. Written here because `EventSource` cannot send
 * an Authorization header, and a key has to travel in one.
 */

export interface SseMessage {
    readonly event: string;
    readonly data: string;
    /** The last id the stream set, which is what a reconnect sends back. */
    readonly id: string | null;
}

export interface SseReader {
    /** The reconnect delay the server last asked for, in milliseconds. */
    retry: number | null;
    lastId: string | null;
}

/** Every message in `body`, in order, as it arrives. */
export async function* readSse(
    body: ReadableStream<Uint8Array>,
    state: SseReader
): AsyncGenerator<SseMessage> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    let event = "";
    let data: string[] = [];
    let sawField = false;

    const line = (text: string): SseMessage | null => {
        if (text === "") {
            const out =
                sawField && data.length > 0
                    ? { event: event || "message", data: data.join("\n"), id: state.lastId }
                    : null;
            event = "";
            data = [];
            sawField = false;
            return out;
        }
        if (text.startsWith(":")) return null;
        const colon = text.indexOf(":");
        const field = colon < 0 ? text : text.slice(0, colon);
        let value = colon < 0 ? "" : text.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id" && !value.includes("\0")) state.lastId = value;
        else if (field === "retry" && /^\d+$/.test(value)) state.retry = Number(value);
        else return null;
        sawField = true;
        return null;
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            // A lone CR at the very end may be the first half of a CRLF.
            for (;;) {
                const match = /\r\n|\r|\n/.exec(buffer);
                if (!match || (match[0] === "\r" && match.index === buffer.length - 1 && !done))
                    break;
                const message = line(buffer.slice(0, match.index));
                buffer = buffer.slice(match.index + match[0].length);
                if (message) yield message;
            }
            if (done) return;
        }
    } finally {
        reader.releaseLock();
    }
}
