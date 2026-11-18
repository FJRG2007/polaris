/**
 * A turn that answered - text, or a view Polar drew - and then broke on a
 * later call is not a turn that could not answer: no failure is written into
 * it, and one an older answer stored is not drawn under it.
 */

import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { answered, failureIntoAnswer } from "@/lib/polar/unanswered";
import { FAILURE_PART, encodePolarFailure } from "@/lib/polar/provider-failure";

const REFUSED = encodePolarFailure({
    code: "provider",
    kind: "key",
    provider: "Anthropic",
    slug: "anthropic",
    payer: "own"
});

async function through(chunks: UIMessageChunk[]): Promise<string[]> {
    const out: string[] = [];
    const stream = new ReadableStream<UIMessageChunk>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        }
    }).pipeThrough(failureIntoAnswer());
    for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) out.push(chunk.type);
    return out;
}

describe("failureIntoAnswer", () => {
    it("writes the failure into a turn that had not answered", async () => {
        expect(await through([{ type: "start" }, { type: "error", errorText: REFUSED }])).toEqual([
            "start",
            FAILURE_PART,
            "error"
        ]);
    });

    it("leaves it out once the answer has text", async () => {
        const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "| Payout | Amount |" },
            { type: "error", errorText: REFUSED }
        ];
        expect(await through(chunks)).not.toContain(FAILURE_PART);
    });

    it("leaves it out once the answer drew a view", async () => {
        const chunks: UIMessageChunk[] = [
            { type: "tool-input-start", toolCallId: "1", toolName: "polar_show" },
            { type: "error", errorText: REFUSED }
        ];
        expect(await through(chunks)).not.toContain(FAILURE_PART);
    });

    it("keeps it after a tool step alone, which is not an answer", async () => {
        const chunks: UIMessageChunk[] = [
            { type: "tool-input-start", toolCallId: "1", toolName: "set_power" },
            { type: "error", errorText: REFUSED }
        ];
        expect(await through(chunks)).toContain(FAILURE_PART);
    });
});

describe("answered", () => {
    it("tells a stored answer with a failure from a failure alone", () => {
        const failure = { type: FAILURE_PART, data: {} };
        expect(answered([{ type: "text", text: "Done." }, failure])).toBe(true);
        expect(answered([{ type: "tool-polar_show", state: "output-available" }, failure])).toBe(true);
        expect(answered([{ type: "step-start" }, failure])).toBe(false);
        expect(answered([{ type: "text", text: "  " }, failure])).toBe(false);
    });
});
