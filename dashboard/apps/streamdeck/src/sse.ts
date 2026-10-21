/**
 * A server-sent event reader, for Polaris's state stream.
 *
 * Node's fetch hands the body over in chunks that split lines anywhere; this
 * holds the unfinished part and yields whole events. Only what the stream
 * uses: `event`, `data` (joined across lines), `retry`, and comments ignored.
 *
 * Pure: the tests feed it strings.
 */

export interface SseEvent {
    readonly event: string;
    readonly data: string;
}

export class SseReader {
    #buffer = "";
    #event = "";
    #data: string[] = [];
    /** The reconnect delay the server last asked for, in milliseconds. */
    retryMs: number | null = null;

    /** Feed a chunk; returns the events it completed. */
    push(chunk: string): SseEvent[] {
        this.#buffer += chunk;
        const done: SseEvent[] = [];
        let newline: number;
        while ((newline = this.#buffer.search(/\r\n|\r|\n/)) !== -1) {
            const line = this.#buffer.slice(0, newline);
            const width = this.#buffer.startsWith("\r\n", newline) ? 2 : 1;
            this.#buffer = this.#buffer.slice(newline + width);
            const event = this.#line(line);
            if (event) done.push(event);
        }
        return done;
    }

    #line(line: string): SseEvent | null {
        if (line === "") {
            if (this.#data.length === 0) {
                this.#event = "";
                return null;
            }
            const event = { event: this.#event || "message", data: this.#data.join("\n") };
            this.#event = "";
            this.#data = [];
            return event;
        }
        if (line.startsWith(":")) return null;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") this.#event = value;
        else if (field === "data") this.#data.push(value);
        else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
        return null;
    }
}
