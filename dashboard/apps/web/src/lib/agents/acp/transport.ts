/**
 * An Agent Client Protocol stream over the session's tmux-held pipe.
 *
 * The pipe is two files on the session's machine (`pipe-commands.ts`), reached
 * one command at a time. Reading is polling: quick while the agent is talking,
 * backing off to a second while it is quiet, so an idle session costs one
 * short command a second rather than a busy loop. Writing is serialised and cut
 * into pieces a single command can carry.
 *
 * The byte streams are handed to the SDK's own newline-delimited JSON framing,
 * and every frame it decodes is then held to the JSON-RPC envelope
 * (`frames.ts`) before the connection sees it.
 */

import * as pipe from "./pipe-commands";
import { MAX_FRAME_BYTES, validatedFrames } from "./frames";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

/** One command on the session's machine, as `runInSession` runs it. */
export type RunCommand = (command: string) => Promise<{ code: number; output: string }>;

/** The two operations the stream needs from the machine. Tests replace it. */
export interface PipeIo {
    /** What the agent wrote after `offset`, or null while none is running. */
    read(offset: number): Promise<pipe.PipeRead | null>;
    /** Append to the agent's input; false when `generation` is not the one
     *  running any more. */
    write(generation: string, bytes: Uint8Array): Promise<boolean>;
}

/** The pipe of the session whose state directory is `stateDir`. */
export function shellPipe(stateDir: string, run: RunCommand): PipeIo {
    return {
        async read(offset) {
            const result = await run(pipe.acpReadCommand(stateDir, offset));
            if (result.code === pipe.ACP_NOT_RUNNING) return null;
            if (result.code !== 0) throw new Error("The agent's output could not be read.");
            const read = pipe.parseAcpRead(result.output);
            if (!read) throw new Error("The agent's output came back in a shape Polaris does not read.");
            return read;
        },
        async write(generation, bytes) {
            const result = await run(pipe.acpWriteCommand(stateDir, generation, bytes));
            if (result.code === pipe.ACP_NOT_RUNNING) return false;
            if (result.code !== 0) throw new Error("The agent's input could not be written.");
            return true;
        }
    };
}

export interface PipeStreamOptions {
    /** Stops polling and closes both sides. */
    readonly signal?: AbortSignal;
    /** The quickest poll, while bytes are arriving. */
    readonly minPollMs?: number;
    /** The slowest poll, once the agent has been quiet a while. */
    readonly maxPollMs?: number;
    /** Reads that may fail in a row before the stream gives up. */
    readonly maxFailures?: number;
    /** A frame that failed the envelope, by method. */
    readonly onDropped?: (what: string) => void;
    /** Tests replace the clock. */
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Why a pipe stream ended without the agent exiting normally. */
export class PipeClosedError extends Error {
    constructor(
        readonly reason: "not-running" | "restarted" | "unreadable",
        message: string
    ) {
        super(message);
        this.name = "PipeClosedError";
    }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}

/**
 * The agent's output and input as byte streams, pinned to the generation of
 * the agent running when the first read answered. A restart while it is open
 * ends the stream (`PipeClosedError("restarted")`) instead of reading the new
 * agent's conversation into the old connection.
 */
export function pipeByteStreams(
    io: PipeIo,
    options: PipeStreamOptions = {}
): { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> } {
    const minPoll = options.minPollMs ?? 50;
    const maxPoll = options.maxPollMs ?? 1_000;
    const maxFailures = options.maxFailures ?? 5;
    const sleep = options.sleep ?? wait;
    const signal = options.signal;

    let generation: string | null = null;
    let offset = 0;
    let poll = minPoll;
    let failures = 0;
    // The first read pins the generation; writes wait for it.
    let pinned: (value: string) => void = () => undefined;
    let unpinned: (reason: unknown) => void = () => undefined;
    const pinnedGeneration = new Promise<string>((resolve, reject) => {
        pinned = resolve;
        unpinned = reject;
    });
    pinnedGeneration.catch(() => undefined);

    const input = new ReadableStream<Uint8Array>({
        async pull(controller) {
            for (;;) {
                if (signal?.aborted) {
                    unpinned(new PipeClosedError("not-running", "The connection to the agent was closed."));
                    controller.close();
                    return;
                }
                let read: pipe.PipeRead | null;
                try {
                    read = await io.read(offset);
                    failures = 0;
                } catch (error) {
                    failures += 1;
                    if (failures >= maxFailures) {
                        const closed = new PipeClosedError(
                            "unreadable",
                            error instanceof Error ? error.message : "The agent's output could not be read."
                        );
                        unpinned(closed);
                        controller.error(closed);
                        return;
                    }
                    await sleep(maxPoll, signal);
                    continue;
                }
                if (!read) {
                    const closed = new PipeClosedError("not-running", "The agent is not running.");
                    unpinned(closed);
                    controller.error(closed);
                    return;
                }
                if (generation === null) {
                    generation = read.generation;
                    pinned(generation);
                } else if (read.generation !== generation) {
                    controller.error(new PipeClosedError("restarted", "The agent was restarted."));
                    return;
                }
                if (read.bytes.byteLength > 0) {
                    offset += read.bytes.byteLength;
                    poll = minPoll;
                    controller.enqueue(read.bytes);
                    return;
                }
                // Drained, and the code was read before the bytes: nothing more
                // is coming.
                if (read.exitCode !== null) {
                    controller.close();
                    return;
                }
                await sleep(poll, signal);
                poll = Math.min(maxPoll, poll * 2);
            }
        }
    });

    const output = new WritableStream<Uint8Array>({
        async write(chunk) {
            const current = await pinnedGeneration;
            for (let start = 0; start < chunk.byteLength; start += pipe.ACP_WRITE_BYTES) {
                const piece = chunk.subarray(start, start + pipe.ACP_WRITE_BYTES);
                if (!(await io.write(current, piece)))
                    throw new PipeClosedError("restarted", "The agent stopped taking input.");
            }
            // Something was asked; the answer is likely soon.
            poll = minPoll;
        }
    });

    return { input, output };
}

/** An SDK stream over the pipe, every inbound frame held to the envelope. */
export function pipeStream(io: PipeIo, options: PipeStreamOptions = {}): Stream {
    const { input, output } = pipeByteStreams(io, options);
    const framed = ndJsonStream(output, input, { maxMessageBytes: MAX_FRAME_BYTES });
    return {
        writable: framed.writable,
        readable: framed.readable.pipeThrough(validatedFrames(options.onDropped ?? (() => undefined)))
    };
}
