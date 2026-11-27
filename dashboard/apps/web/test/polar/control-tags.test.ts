import { wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
    answerText,
    cleanControlStream,
    ControlTagScanner,
    controlTagsMiddleware,
    shownParts,
    splitControlTags,
    type ControlSegment
} from "@/lib/polar/control-tags";

/** What the scanner shows for `chunks`, segments of a kind merged. */
function scan(chunks: readonly string[]): ControlSegment[] {
    const scanner = new ControlTagScanner();
    const out: ControlSegment[] = [];
    for (const segment of [...chunks.flatMap((chunk) => scanner.push(chunk)), ...scanner.end()]) {
        const last = out.at(-1);
        if (last?.kind === segment.kind) last.text += segment.text;
        else out.push({ ...segment });
    }
    return out;
}

/** Every way of cutting `text` in two. */
function everySplit(text: string): string[][] {
    return Array.from({ length: text.length + 1 }, (_, at) => [text.slice(0, at), text.slice(at)]);
}

describe("control tags", () => {
    it("drops the answer wrapper", () => {
        expect(scan(["<final_answer>Hello there.</final_answer>"])).toEqual([
            { kind: "text", text: "Hello there." }
        ]);
        expect(scan(["<answer>\nYes.\n</answer>"])).toEqual([{ kind: "text", text: "Yes." }]);
    });

    it("moves <think> to the thinking", () => {
        expect(scan(["<think>The user greets.</think>\n\nHi!"])).toEqual([
            { kind: "reasoning", text: "The user greets." },
            { kind: "text", text: "Hi!" }
        ]);
    });

    it("holds a tag cut across chunks, at every cut", () => {
        const text = "<think>plan</think><final_answer>Done.</final_answer>";
        for (const chunks of everySplit(text)) {
            expect(scan(chunks), JSON.stringify(chunks)).toEqual([
                { kind: "reasoning", text: "plan" },
                { kind: "text", text: "Done." }
            ]);
        }
    });

    it("never shows a partial tag while it streams", () => {
        const scanner = new ControlTagScanner();
        const shown = [...scanner.push("Sure.<final_"), ...scanner.push("ans")]
            .map((segment) => segment.text)
            .join("");
        expect(shown).toBe("Sure.");
        expect(scanner.push("wer>")).toEqual([]);
    });

    it("streams one character at a time", () => {
        const text = "<think>a</think>Answer <b>bold</b>.</final_answer>";
        expect(scan([...text])).toEqual([
            { kind: "reasoning", text: "a" },
            { kind: "text", text: "Answer <b>bold</b>." }
        ]);
    });

    it("leaves unknown and HTML tags alone", () => {
        const text = "Use <div> and <section> here, or <custom_tag>.";
        expect(scan([text])).toEqual([{ kind: "text", text }]);
        expect(splitControlTags(text).changed).toBe(false);
    });

    it("keeps a tag inside a fenced code block", () => {
        const text = "Like this:\n\n```xml\n<final_answer>42</final_answer>\n<think>x</think>\n```\n\nThat is all.";
        for (const chunks of everySplit(text)) {
            expect(scan(chunks), JSON.stringify(chunks)).toEqual([{ kind: "text", text }]);
        }
    });

    it("keeps a tag inside inline code", () => {
        const text = "Wrap it in `<final_answer>` and close with `</think>`.";
        expect(scan([text])).toEqual([{ kind: "text", text }]);
    });

    it("cleans after a fence closes", () => {
        expect(scan(["```\n<answer>\n```\n</final_answer>"])).toEqual([
            { kind: "text", text: "```\n<answer>\n```" }
        ]);
    });

    it("only opens thinking at the start of a line", () => {
        const text = "The model writes <think> before it reasons.";
        expect(scan([text])).toEqual([{ kind: "text", text }]);
    });

    it("drops a stray closing thinking tag", () => {
        expect(scan(["reasoned</think>\nThe answer."])).toEqual([
            { kind: "text", text: "reasoned\nThe answer." }
        ]);
    });

    it("splits the harmony channels", () => {
        const text =
            "<|channel|>analysis<|message|>Think it over.<|end|><|start|>assistant<|channel|>final<|message|>Hello!<|return|>";
        for (const chunks of everySplit(text)) {
            expect(scan(chunks), JSON.stringify(chunks)).toEqual([
                { kind: "reasoning", text: "Think it over." },
                { kind: "text", text: "Hello!" }
            ]);
        }
    });

    it("splits harmony with its tokens stripped", () => {
        const text = "analysisThe user says hi.assistantfinalHi, how can I help?";
        for (const chunks of everySplit(text)) {
            expect(scan(chunks), JSON.stringify(chunks)).toEqual([
                { kind: "reasoning", text: "The user says hi." },
                { kind: "text", text: "Hi, how can I help?" }
            ]);
        }
    });

    it("keeps an answer that starts with the word analysis", () => {
        const text = "analysis of the data shows growth.";
        expect(scan([text])).toEqual([{ kind: "text", text }]);
    });

    it("drops chat-template tokens", () => {
        expect(scan(["Hello<|im_end|>"])).toEqual([{ kind: "text", text: "Hello" }]);
        expect(scan(["Fine.<|eot_id|>"])).toEqual([{ kind: "text", text: "Fine." }]);
    });

    it("keeps a lone angle bracket", () => {
        for (const text of ["a < b", "x <", "<", "1 <2"]) {
            expect(scan([text])).toEqual([{ kind: "text", text }]);
        }
    });

    it("answerText keeps only what is said", () => {
        expect(answerText("<final_answer>Trip ideas</final_answer>")).toBe("Trip ideas");
        expect(answerText("Plain title")).toBe("Plain title");
    });
});

describe("stored answers", () => {
    it("are cleaned on read", () => {
        const parts = [
            { type: "step-start" },
            { type: "text", text: "<think>hmm</think>Hello.</final_answer>", state: "done" }
        ];
        expect(shownParts("assistant", parts)).toEqual([
            { type: "step-start" },
            { type: "reasoning", text: "hmm", state: "done" },
            { type: "text", text: "Hello.", state: "done" }
        ]);
    });

    it("keep the same array when nothing changes", () => {
        const parts = [{ type: "text", text: "Nothing to clean, `<final_answer>` in code." }];
        expect(shownParts("assistant", parts)).toBe(parts);
    });

    it("leave what a person wrote alone", () => {
        const parts = [{ type: "text", text: "<final_answer>is my literal question</final_answer>" }];
        expect(shownParts("user", parts)).toBe(parts);
    });
});

type Part = { type: string; id?: string; delta?: string; [key: string]: unknown };

async function run(parts: Part[]): Promise<Part[]> {
    const source = new ReadableStream<Part>({
        start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
        }
    });
    const out: Part[] = [];
    const reader = source.pipeThrough(cleanControlStream() as unknown as TransformStream<Part, Part>).getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return out;
        out.push(value);
    }
}

describe("the stream", () => {
    it("turns tagged text into reasoning and text parts", async () => {
        const out = await run([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "<thi" },
            { type: "text-delta", id: "t", delta: "nk>why</think>\n<final_" },
            { type: "text-delta", id: "t", delta: "answer>Because.</final_answer>" },
            { type: "text-end", id: "t" },
            { type: "finish" }
        ]);
        expect(out).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "t:0" },
            { type: "reasoning-delta", id: "t:0", delta: "why" },
            { type: "reasoning-end", id: "t:0" },
            { type: "text-start", id: "t:1" },
            { type: "text-delta", id: "t:1", delta: "Because." },
            { type: "text-end", id: "t:1" },
            { type: "finish" }
        ]);
    });

    it("passes clean text through with its id and metadata", async () => {
        const meta = { google: { thoughtSignature: "sig" } };
        const out = await run([
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Hello", providerMetadata: meta },
            { type: "text-end", id: "t" }
        ]);
        expect(out).toEqual([
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Hello", providerMetadata: meta },
            { type: "text-end", id: "t" }
        ]);
    });

    it("wraps a model's stream and its generated text", async () => {
        const model = wrapLanguageModel({
            model: {
                specificationVersion: "v4",
                provider: "test",
                modelId: "test",
                supportedUrls: {},
                doGenerate: async () => ({
                    content: [{ type: "text", text: "<final_answer>42</final_answer>" }],
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {} as never,
                    warnings: []
                }),
                doStream: async () => ({
                    stream: new ReadableStream({
                        start(controller) {
                            controller.enqueue({ type: "text-start", id: "a" });
                            controller.enqueue({ type: "text-delta", id: "a", delta: "<final_answer>42" });
                            controller.enqueue({ type: "text-end", id: "a" });
                            controller.close();
                        }
                    })
                })
            } as never,
            middleware: controlTagsMiddleware
        });
        const generated = await model.doGenerate({ prompt: [] } as never);
        expect(generated.content).toEqual([{ type: "text", text: "42" }]);
        const { stream } = await model.doStream({ prompt: [] } as never);
        const deltas: string[] = [];
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.type === "text-delta") deltas.push(value.delta);
        }
        expect(deltas.join("")).toBe("42");
    });
});
