/**
 * Drafts across processes: a publisher sends what was added at most every
 * gap, a frame is cut into pieces NOTIFY carries, and a process holds and
 * forwards the drafts it hears of, skipping its own echo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listened: { channel: string; onNotice: (payload: string) => void }[] = [];
const notified: { channel: string; payload: string }[] = [];

vi.mock("@/lib/live/pg-listener", () => ({
    NOTIFY_PAYLOAD_LIMIT: 8000,
    pgListener: () => ({
        listen: (channel: string, handlers: { onNotice: (payload: string) => void }) => {
            listened.push({ channel, onNotice: handlers.onNotice });
            return () => undefined;
        }
    })
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        $executeRaw: async (_strings: TemplateStringsArray, channel: string, payload: string) => {
            notified.push({ channel, payload });
            return 1;
        }
    }
}));

import type { DraftFrame } from "@/lib/agents/draft-frames";
import {
    currentDraft,
    DRAFT_CHANNEL,
    DraftPublisher,
    draftNotices,
    PIECE_CHARS,
    publishDraft,
    receiveDraftNotice,
    subscribeDraft
} from "@/lib/agents/session-drafts";

const SESSION = "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";
const OTHER_NODE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DraftPublisher", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("sends the first text at once and the rest of a burst as one frame after the gap", () => {
        const frames: DraftFrame[] = [];
        const publisher = new DraftPublisher((frame) => frames.push(frame), { everyMs: 200, now: () => Date.now() });
        publisher.set("m1", "He");
        publisher.set("m1", "Hel");
        publisher.set("m1", "Hello");
        expect(frames).toEqual([{ id: "m1", from: 0, text: "He" }]);
        vi.advanceTimersByTime(200);
        expect(frames).toEqual([
            { id: "m1", from: 0, text: "He" },
            { id: "m1", from: 2, text: "llo" }
        ]);
        publisher.end();
        expect(frames.at(-1)).toEqual({ id: "m1", from: 0, text: "", end: true });
    });

    it("ends the last message when another starts, and drops what was waiting", () => {
        const frames: DraftFrame[] = [];
        const publisher = new DraftPublisher((frame) => frames.push(frame), { everyMs: 200, now: () => Date.now() });
        publisher.set("m1", "One");
        publisher.set("m1", "One more");
        publisher.set("m2", "Two");
        expect(frames).toEqual([
            { id: "m1", from: 0, text: "One" },
            { id: "m1", from: 0, text: "", end: true }
        ]);
        vi.advanceTimersByTime(200);
        expect(frames.at(-1)).toEqual({ id: "m2", from: 0, text: "Two" });
    });

    it("sends no end for a draft nobody was shown", () => {
        const frames: DraftFrame[] = [];
        const publisher = new DraftPublisher((frame) => frames.push(frame), { everyMs: 200, now: () => Date.now() });
        publisher.end();
        publisher.set("m1", "a");
        vi.advanceTimersByTime(10);
        publisher.end();
        publisher.end();
        expect(frames).toEqual([
            { id: "m1", from: 0, text: "a" },
            { id: "m1", from: 0, text: "", end: true }
        ]);
    });
});

describe("draftNotices", () => {
    it("cuts a long frame into ordered pieces that fit NOTIFY", () => {
        const text = "\u0001".repeat(PIECE_CHARS * 2 + 5);
        const pieces = draftNotices(SESSION, { id: "x".repeat(300), from: 7, text }, OTHER_NODE);
        expect(pieces).toHaveLength(3);
        const parsed = pieces.map((piece) => JSON.parse(piece) as { f: DraftFrame });
        expect(parsed.map((piece) => piece.f.from)).toEqual([7, 7 + PIECE_CHARS, 7 + PIECE_CHARS * 2]);
        expect(parsed.map((piece) => piece.f.text).join("")).toBe(text);
        // Control characters are the worst case: six bytes each once escaped.
        for (const piece of pieces) expect(Buffer.byteLength(piece, "utf8")).toBeLessThan(8000);
    });
});

describe("a process's drafts", () => {
    beforeEach(() => {
        notified.length = 0;
    });

    it("forwards its own frames to the session's streams, holds them, and NOTIFYs the rest", async () => {
        const seen: DraftFrame[] = [];
        const stop = subscribeDraft(SESSION, (frame) => seen.push(frame));
        expect(listened.map((entry) => entry.channel)).toContain(DRAFT_CHANNEL);
        publishDraft(SESSION, { id: "m1", from: 0, text: "Hi" });
        publishDraft(SESSION, { id: "m1", from: 2, text: " there" });
        expect(seen).toHaveLength(2);
        expect(currentDraft(SESSION)).toEqual({ id: "m1", from: 0, text: "Hi there" });
        await flushed();
        expect(notified.map((entry) => entry.channel)).toEqual([DRAFT_CHANNEL, DRAFT_CHANNEL]);

        // The echo of its own notice is skipped.
        receiveDraftNotice(notified[0]!.payload);
        expect(seen).toHaveLength(2);

        publishDraft(SESSION, { id: "m1", from: 0, text: "", end: true });
        expect(currentDraft(SESSION)).toBeNull();
        stop();
    });

    it("holds and forwards a draft written in another process", () => {
        const seen: DraftFrame[] = [];
        const stop = subscribeDraft(SESSION, (frame) => seen.push(frame));
        const onNotice = listened.find((entry) => entry.channel === DRAFT_CHANNEL)!.onNotice;
        for (const payload of draftNotices(SESSION, { id: "m9", from: 0, text: "From afar" }, OTHER_NODE))
            onNotice(payload);
        expect(seen).toEqual([{ id: "m9", from: 0, text: "From afar" }]);
        expect(currentDraft(SESSION)?.text).toBe("From afar");
        // Not a notice: ignored.
        onNotice("not json");
        onNotice(JSON.stringify({ n: OTHER_NODE, s: "not-a-session", f: { id: "m", from: 0, text: "x" } }));
        expect(seen).toHaveLength(1);
        stop();
    });
});
