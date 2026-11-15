/**
 * An in-memory session pipe with a scripted agent behind it, for the ACP
 * client tests. The agent answers each request with frames recorded from the
 * protocol's documentation (`fixtures/prompt-turn.jsonl`), rewriting only the
 * response id to the one the client actually used.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { PipeIo } from "@/lib/agents/acp/transport";
import { ACP_READ_BYTES, type PipeRead } from "@/lib/agents/acp/pipe-commands";

export const RECORDED: readonly Record<string, unknown>[] = readFileSync(
    join(__dirname, "fixtures", "prompt-turn.jsonl"),
    "utf8"
)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

type Frame = Record<string, unknown>;

export class FakePipe implements PipeIo {
    generation = "1700000000000000000-42";
    exitCode: number | null = null;
    running = true;
    /** The id of the prompt being answered. */
    promptId: unknown = null;
    /** Every frame the client wrote, parsed. */
    readonly received: Frame[] = [];
    /** Raw writes, as the client sent them. */
    readonly writes: Uint8Array[] = [];
    private out = Buffer.alloc(0);
    private inbox = "";

    constructor(private readonly respond: (frame: Frame, pipe: FakePipe) => void = scriptedAgent) {}

    /** The agent writes a line to its standard output. */
    emit(frame: Frame | string): void {
        const line = typeof frame === "string" ? frame : JSON.stringify(frame);
        this.out = Buffer.concat([this.out, Buffer.from(`${line}\n`, "utf8")]);
    }

    async read(offset: number): Promise<PipeRead | null> {
        if (!this.running) return null;
        const bytes = new Uint8Array(this.out.subarray(offset, offset + ACP_READ_BYTES));
        return { generation: this.generation, exitCode: this.exitCode, bytes };
    }

    async write(generation: string, bytes: Uint8Array): Promise<boolean> {
        if (!this.running || generation !== this.generation || this.exitCode !== null) return false;
        this.writes.push(bytes);
        this.inbox += Buffer.from(bytes).toString("utf8");
        let newline = this.inbox.indexOf("\n");
        while (newline >= 0) {
            const line = this.inbox.slice(0, newline);
            this.inbox = this.inbox.slice(newline + 1);
            if (line.trim()) {
                const frame = JSON.parse(line) as Frame;
                this.received.push(frame);
                this.respond(frame, this);
            }
            newline = this.inbox.indexOf("\n");
        }
        return true;
    }
}

/** The recorded conversation, played back in answer to the client. */
export function scriptedAgent(frame: Frame, pipe: FakePipe): void {
    const withId = (recorded: Frame, id: unknown): Frame => ({ ...recorded, id });
    if (frame.method === "initialize") pipe.emit(withId(RECORDED[0]!, frame.id));
    else if (frame.method === "session/new") pipe.emit(withId(RECORDED[1]!, frame.id));
    else if (frame.method === "session/prompt") {
        pipe.promptId = frame.id;
        for (const recorded of RECORDED.slice(2, 6)) pipe.emit(recorded);
    } else if (frame.id === 5 && "result" in frame) {
        pipe.emit(RECORDED[6]!);
        pipe.emit(RECORDED[7]!);
        pipe.emit(withId(RECORDED[8]!, pipe.promptId));
    }
}

/** A clock that does not wait, so polling runs as fast as the test. */
export const noSleep = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
