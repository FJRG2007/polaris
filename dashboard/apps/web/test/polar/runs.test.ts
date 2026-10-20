import { afterEach, describe, expect, it, vi } from "vitest";
import {
    POLAR_RUNS_MAX,
    beginPolarRun,
    chunkType,
    listPolarRuns,
    replayPolarRun,
    resetPolarRuns,
    stopPolarRun,
    type PolarRunEnd,
    type PolarRunHandle
} from "@/lib/polar/runs";

const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-0000000000a1";

const sse = (part: object) => `data: ${JSON.stringify(part)}\n\n`;

/** A stream the test writes to, as `consumeSseStream` would hand it over. */
function source() {
    let controller!: ReadableStreamDefaultController<string>;
    const stream = new ReadableStream<string>({ start: (c) => void (controller = c) });
    return { stream, controller };
}

function started(onEnd?: (end: PolarRunEnd) => void, thread = THREAD, user = USER) {
    const run = beginPolarRun(user, thread, onEnd);
    if (typeof run === "string") throw new Error(run);
    const { stream, controller } = source();
    run.consume({ stream });
    return { run: run as PolarRunHandle, controller };
}

async function readAll(stream: ReadableStream<string>): Promise<string[]> {
    const out: string[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return out;
        out.push(value);
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => resetPolarRuns());

describe("polar runs", () => {
    it("reads the type of a chunk, and nothing from the end marker", () => {
        expect(chunkType(sse({ type: "text-delta", delta: "a" }))).toBe("text-delta");
        expect(chunkType("data: [DONE]\n\n")).toBeNull();
        expect(chunkType(": keep-alive\n\n")).toBeNull();
        expect(chunkType("data: {broken\n\n")).toBeNull();
    });

    it("replays an answer from its start and follows it to the end", async () => {
        const { controller } = started();
        controller.enqueue(sse({ type: "start", messageId: "m1" }));
        controller.enqueue(sse({ type: "text-delta", delta: "Hel" }));
        await settle();
        const replay = replayPolarRun(USER, THREAD);
        expect(replay).not.toBeNull();
        const read = readAll(replay!);
        controller.enqueue(sse({ type: "text-delta", delta: "lo" }));
        controller.close();
        expect((await read).map(chunkType)).toEqual(["start", "text-delta", "text-delta"]);
        // Ended: the stored message answers now, not a replay.
        expect(replayPolarRun(USER, THREAD)).toBeNull();
    });

    it("never shows or stops another person's run", async () => {
        started();
        await settle();
        expect(replayPolarRun(OTHER, THREAD)).toBeNull();
        expect(stopPolarRun(OTHER, THREAD)).toBe(false);
        expect(listPolarRuns(OTHER)).toEqual([]);
        expect(beginPolarRun(OTHER, THREAD)).toBe("busy");
    });

    it("keeps one run per thread and a ceiling per person", () => {
        started();
        expect(beginPolarRun(USER, THREAD)).toBe("busy");
        for (let index = 1; index < POLAR_RUNS_MAX; index += 1)
            started(undefined, `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`);
        expect(beginPolarRun(USER, "00000000-0000-4000-8000-0000000002ff")).toBe("too_many");
        // Somebody else is not counted against this person.
        expect(typeof beginPolarRun(OTHER, "00000000-0000-4000-8000-0000000003ff")).toBe("object");
    });

    it("tells about an unwatched run, and marks it unread until opened", async () => {
        const onEnd = vi.fn();
        const { controller } = started(onEnd);
        controller.enqueue(sse({ type: "text-delta", delta: "x" }));
        controller.close();
        await settle();
        expect(onEnd).toHaveBeenCalledWith({
            userId: USER,
            threadId: THREAD,
            state: "done",
            watched: false
        });
        expect(listPolarRuns(USER)).toMatchObject([{ threadId: THREAD, state: "done", unread: true }]);
        expect(replayPolarRun(USER, THREAD)).toBeNull();
        expect(listPolarRuns(USER)).toEqual([]);
    });

    it("says a watched run was watched, and keeps an approval marked", async () => {
        const onEnd = vi.fn();
        const { run, controller } = started(onEnd);
        const screen = new AbortController();
        run.watch(screen.signal);
        controller.enqueue(sse({ type: "tool-approval-request", approvalId: "a", toolCallId: "c" }));
        controller.close();
        await settle();
        expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ state: "approval", watched: true }));
        expect(listPolarRuns(USER)).toMatchObject([{ state: "approval", unread: false }]);
    });

    it("counts a chat left mid-answer as unwatched", async () => {
        const onEnd = vi.fn();
        const { run, controller } = started(onEnd);
        const screen = new AbortController();
        run.watch(screen.signal);
        screen.abort();
        controller.close();
        await settle();
        expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ watched: false }));
    });

    it("stops on request, says nothing about it, and frees the thread", async () => {
        const onEnd = vi.fn();
        const { run, controller } = started(onEnd);
        expect(stopPolarRun(USER, THREAD)).toBe(true);
        expect(run.signal.aborted).toBe(true);
        // A new turn may start before the stopped stream has wound down.
        expect(typeof beginPolarRun(USER, THREAD)).toBe("object");
        controller.close();
        await settle();
        expect(onEnd).not.toHaveBeenCalled();
    });

    it("lists a running answer as running", () => {
        started();
        expect(listPolarRuns(USER)).toMatchObject([{ threadId: THREAD, state: "running" }]);
    });
});
