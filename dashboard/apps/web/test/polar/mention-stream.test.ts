/**
 * Polar's answer to a mention, read as it is written: the draft carries the
 * whole text so far a few times a second, takes back what a step said before
 * calling its tools, never shows a tool call written out as words, and the
 * answer the caller checks is the last step's text, as `generateText` gives it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let parts: unknown[] = [];
vi.mock("ai", () => ({
    streamText: () => ({
        stream: (async function* () {
            for (const part of parts) yield part;
        })()
    })
}));

import { DRAFT_EVERY_MS, draftable, streamAnswer } from "@/lib/polar/mention-stream";

const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
const markup = (text: string) => /<invoke\b/.test(text);
const visible = (text: string) => draftable(text, markup, (value) => value);

/** A clock that moves on by `step` every time it is read. */
function clock(step: number) {
    let at = 0;
    return () => (at += step);
}

beforeEach(() => {
    parts = [];
});

describe("the draft of an answer", () => {
    it("grows with the whole text so far, and the answer is what was written", async () => {
        parts = [
            { type: "start-step" },
            { type: "text-delta", text: "Hola, " },
            { type: "text-delta", text: "Ada." },
            { type: "finish-step", finishReason: "stop" },
            { type: "finish", totalUsage: usage }
        ];
        const drafts: string[] = [];
        const answer = await streamAnswer({} as never, (text) => drafts.push(text), visible, clock(DRAFT_EVERY_MS));
        expect(drafts).toEqual(["Hola,", "Hola, Ada."]);
        expect(answer).toEqual({ text: "Hola, Ada.", totalUsage: usage });
    });

    it("is sent a few times a second at most, and whole at the end of the step", async () => {
        parts = [
            { type: "start-step" },
            ...Array.from({ length: 20 }, () => ({ type: "text-delta", text: "a" })),
            { type: "finish-step", finishReason: "stop" },
            { type: "finish", totalUsage: usage }
        ];
        const drafts: string[] = [];
        await streamAnswer({} as never, (text) => drafts.push(text), visible, clock(10));
        expect(drafts.length).toBeLessThan(5);
        expect(drafts.at(-1)).toBe("a".repeat(20));
    });

    it("takes back what a step said before calling its tools", async () => {
        parts = [
            { type: "start-step" },
            { type: "text-delta", text: "Let me look." },
            { type: "finish-step", finishReason: "tool-calls" },
            { type: "start-step" },
            { type: "text-delta", text: "There are two." },
            { type: "finish-step", finishReason: "stop" },
            { type: "finish", totalUsage: usage }
        ];
        const drafts: string[] = [];
        const answer = await streamAnswer({} as never, (text) => drafts.push(text), visible, clock(DRAFT_EVERY_MS));
        expect(drafts).toEqual(["Let me look.", "", "There are two."]);
        expect(answer.text).toBe("There are two.");
    });

    it("never shows a tool call written out as words, not even its start", async () => {
        parts = [
            { type: "start-step" },
            { type: "text-delta", text: "<inv" },
            { type: "text-delta", text: 'oke name="polaris_tools">' },
            { type: "text-delta", text: "more" },
            { type: "finish-step", finishReason: "stop" },
            { type: "finish", totalUsage: usage }
        ];
        const drafts: string[] = [];
        await streamAnswer({} as never, (text) => drafts.push(text), visible, clock(DRAFT_EVERY_MS));
        expect(drafts.every((text) => !text.includes("<"))).toBe(true);
    });

    it("throws what the provider failed with, as generateText does", async () => {
        const failure = new Error("429");
        parts = [{ type: "start-step" }, { type: "error", error: failure }];
        await expect(streamAnswer({} as never, () => undefined, visible)).rejects.toBe(failure);
    });
});

describe("what of a text being written can be shown", () => {
    it("holds back an unfinished tag, and lets a finished one through to be cleaned", () => {
        expect(visible("Two <b")).toBe("Two");
        expect(visible("Two <")).toBe("Two");
        expect(visible('Two <tool name="po')).toBe("Two");
        // A comparison is not a tag, and never holds the rest back.
        expect(visible("a < b and more")).toBe("a < b and more");
        expect(visible("Two <b>x</b>")).toBe("Two <b>x</b>");
        expect(visible('<invoke name="x">')).toBeNull();
    });
});
