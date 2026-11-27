/**
 * What a `/btw` side question reads: the chat so far, mid-turn included - the
 * tool results the turn on its way has gathered, never the words it is still
 * writing - and that it is a command run beside the chat, never sent to it.
 */

import * as btw from "@/lib/polar/btw";
import { describe, expect, it } from "vitest";
import { controlCommandIn, POLAR_RESERVED_SHORTCUTS } from "@/lib/polar/shared";

const user = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });

describe("btwContext", () => {
    const writing = {
        role: "assistant",
        parts: [
            { type: "tool-read_file", state: "output-available", input: {}, output: "PORT=8080" },
            { type: "text", text: "Half a sentence being wri" }
        ]
    };

    it("keeps what the turn on its way gathered, not what it is still writing", () => {
        const text = btw.btwContext([user("Read the env file"), writing], true);
        expect(text).toContain("Read the env file");
        expect(text).toContain("PORT=8080");
        expect(text).not.toContain("Half a sentence");
    });

    it("keeps a finished answer's words", () => {
        const text = btw.btwContext([user("Read the env file"), writing], false);
        expect(text).toContain("Half a sentence");
    });

    it("reads from the newest compaction on", () => {
        const marker = {
            role: "assistant",
            parts: [{ type: "text", text: "Summary: we picked Postgres." }],
            metadata: { compaction: { auto: false, keep: 0, at: "2026-11-27T00:00:00.000Z" } }
        };
        const text = btw.btwContext([user("old question"), marker, user("new question")], false);
        expect(text).toContain("we picked Postgres");
        expect(text).not.toContain("old question");
        expect(text).toContain("new question");
    });

    it("never sends more than its ceiling", () => {
        const long = user("x".repeat(btw.POLAR_BTW_CONTEXT_MAX + 50));
        expect(btw.btwContext([long], false).length).toBeLessThanOrEqual(btw.POLAR_BTW_CONTEXT_MAX);
    });
});

describe("/btw as a command", () => {
    it("is read as a control command with its question, so it never reaches the model as a message", () => {
        expect(controlCommandIn("/btw what was that file?")).toEqual({
            command: "btw",
            rest: "what was that file?"
        });
        expect(controlCommandIn("/btw")).toEqual({ command: "btw", rest: "" });
        expect(controlCommandIn("/recap")).toEqual({ command: "recap", rest: "" });
        expect(POLAR_RESERVED_SHORTCUTS).toContain("btw");
    });

    it("replays only the newest exchanges", () => {
        const earlier = Array.from({ length: 30 }, (_, at) => ({ question: `q${at}`, answer: "a" }));
        const kept = btw.replayed(earlier);
        expect(kept).toHaveLength(btw.POLAR_BTW_EARLIER_MOST);
        expect(kept.at(-1)?.question).toBe("q29");
    });
});
