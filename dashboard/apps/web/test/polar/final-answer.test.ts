/**
 * A turn that ends on its tool steps with nothing said gets one more step
 * with no tools; one that did answer, failed or was stopped does not.
 */

import type { UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";
import { finalAnswer } from "@/lib/polar/unanswered";

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        }
    });
}

async function read(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
    const out: UIMessageChunk[] = [];
    const reader = stream.getReader();
    for (;;) {
        const next = await reader.read();
        if (next.done) return out;
        out.push(next.value);
    }
}

const toolOnly: UIMessageChunk[] = [
    { type: "start" },
    { type: "tool-input-available", toolCallId: "c1", toolName: "games_player_inventory", input: {} },
    { type: "finish", messageMetadata: { usage: { inputTokens: 10 } } }
];

const followUp: UIMessageChunk[] = [
    { type: "start" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "He holds a sword." },
    { type: "text-end", id: "t" },
    { type: "finish" }
];

describe("finalAnswer", () => {
    it("asks once more after an empty ending and puts the finish last", async () => {
        const more = vi.fn(async () => streamOf(followUp));
        const finished = vi.fn(async (held: UIMessageChunk) => ({ ...held, messageMetadata: { counted: true } }));
        const out = await read(streamOf(toolOnly).pipeThrough(finalAnswer(more, finished)));
        expect(more).toHaveBeenCalledTimes(1);
        expect(out.map((chunk) => chunk.type)).toEqual([
            "start",
            "tool-input-available",
            "text-start",
            "text-delta",
            "text-end",
            "finish"
        ]);
        expect(out.at(-1)).toEqual({ type: "finish", messageMetadata: { counted: true } });
    });

    it("asks nothing more when the answer said something", async () => {
        const more = vi.fn(async () => streamOf(followUp));
        const said: UIMessageChunk[] = [
            { type: "start" },
            { type: "text-start", id: "a" },
            { type: "text-delta", id: "a", delta: "Done." },
            { type: "text-end", id: "a" },
            { type: "finish" }
        ];
        const out = await read(streamOf(said).pipeThrough(finalAnswer(more)));
        expect(more).not.toHaveBeenCalled();
        expect(out).toEqual(said);
    });

    it("asks nothing more after a failure or a stop", async () => {
        const ends: UIMessageChunk[] = [{ type: "error", errorText: "x" }, { type: "abort" }];
        for (const end of ends) {
            const more = vi.fn(async () => streamOf(followUp));
            const chunks = [...toolOnly.slice(0, 2), end, toolOnly[2]!];
            await read(streamOf(chunks).pipeThrough(finalAnswer(more)));
            expect(more).not.toHaveBeenCalled();
        }
    });

    it("keeps the answer's finish when the extra step cannot be asked", async () => {
        const more = vi.fn(async (): Promise<ReadableStream<UIMessageChunk> | null> => {
            throw new Error("offline");
        });
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const out = await read(streamOf(toolOnly).pipeThrough(finalAnswer(more)));
        error.mockRestore();
        expect(out.at(-1)?.type).toBe("finish");
        expect(out).toHaveLength(3);
    });
});
