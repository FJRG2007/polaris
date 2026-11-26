/**
 * A message typed while Polar Chat works waits as typed - words, context,
 * files and model - and Send at an open approval denies it first, then sends.
 */

import { describe, expect, it } from "vitest";
import { chatSendRoute, MAX_QUEUE, queuedMessageSchema, queuedPrompt } from "@/lib/polar/shared";

describe("queuedMessageSchema", () => {
    const file = { mediaType: "image/png", filename: "shot.png", url: "/api/attachments/a1", size: 1200 };

    it("keeps the files, context and model a message was typed with", () => {
        const parsed = queuedMessageSchema.parse({
            id: "q1",
            text: "  look  ",
            context: "> quoted",
            files: [file],
            choice: { provider: "anthropic", model: "claude-x" }
        });
        expect(parsed.text).toBe("look");
        expect(parsed.files).toEqual([file]);
        expect(parsed.context).toBe("> quoted");
        expect(parsed.choice).toMatchObject({ provider: "anthropic", model: "claude-x", kind: "language" });
    });

    it("takes files with no words", () => {
        expect(queuedMessageSchema.safeParse({ id: "q1", text: "   ", files: [file] }).success).toBe(true);
    });

    it("refuses a message with neither words nor files", () => {
        expect(queuedMessageSchema.safeParse({ id: "q1", text: "  " }).success).toBe(false);
        expect(queuedMessageSchema.safeParse({ id: "q1", text: "", files: [] }).success).toBe(false);
    });

    it("still reads a row saved as plain text before files and context were kept", () => {
        expect(queuedMessageSchema.parse({ id: "q1", text: "hello" })).toEqual({ id: "q1", text: "hello" });
    });

    it("refuses a file with no address and more files than a message holds", () => {
        expect(queuedMessageSchema.safeParse({ id: "q1", text: "x", files: [{ ...file, url: "" }] }).success).toBe(false);
        expect(queuedMessageSchema.safeParse({ id: "q1", text: "x", files: Array(7).fill(file) }).success).toBe(false);
    });
});

describe("queuedPrompt", () => {
    it("puts the context in front of the words", () => {
        expect(queuedPrompt({ context: "> quoted" }, "why?")).toBe("> quoted\n\nwhy?");
    });

    it("sends the words alone without context, and the context alone without words", () => {
        expect(queuedPrompt({}, "why?")).toBe("why?");
        expect(queuedPrompt({ context: "> quoted" }, "")).toBe("> quoted");
    });
});

describe("chatSendRoute", () => {
    it("denies an open approval, then sends", () => {
        expect(chatSendRoute({ busy: false, waitingApproval: true, queued: 0 })).toBe("deny-then-send");
    });

    it("queues while a turn runs, and says so when the queue is full", () => {
        expect(chatSendRoute({ busy: true, waitingApproval: false, queued: 0 })).toBe("queue");
        expect(chatSendRoute({ busy: true, waitingApproval: true, queued: 3 })).toBe("queue");
        expect(chatSendRoute({ busy: true, waitingApproval: false, queued: MAX_QUEUE })).toBe("full");
    });

    it("sends at once when nothing is running or waiting", () => {
        expect(chatSendRoute({ busy: false, waitingApproval: false, queued: 0 })).toBe("send");
    });
});
