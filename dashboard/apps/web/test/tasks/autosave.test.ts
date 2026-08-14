// @vitest-environment jsdom

/**
 * What the task panel's autosave promises: that nothing typed into it is lost.
 *
 * The failure it exists for is a timing one - a description written and the panel
 * closed on the same breath - so what has to be proven is timing: that a keystroke
 * is written without being blurred, that closing waits for the write rather than
 * racing it, that two writes cannot overtake each other, and that a write the server
 * refused stays an unsaved edit instead of being quietly dropped.
 */

import { act, renderHook } from "@testing-library/react";
import { useAutosave, type Write } from "@/app/(app)/tasks/autosave";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SETTLE_MS = 50;

/** A write that records that it ran, and whether the server took it. */
function writer(written: string[], label: string, taken = true): Write {
    return async () => {
        written.push(label);
        return taken;
    };
}

/** A write the test decides the moment of, so it can be caught mid-flight. */
function heldOpen(written: string[], label: string) {
    let answer: (taken: boolean) => void = () => undefined;
    const server = new Promise<boolean>((resolve) => {
        answer = resolve;
    });
    const write: Write = async () => {
        written.push(`${label}: sent`);
        const taken = await server;
        written.push(`${label}: answered`);
        return taken;
    };
    return { write, answer: (taken = true) => answer(taken) };
}

/** Let the promises settle without moving the clock. */
const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the autosave behind a task", () => {
    it("writes what was typed once typing stops, and only the last of it", async () => {
        const written: string[] = [];
        const { result } = renderHook(() => useAutosave(SETTLE_MS));

        act(() => result.current.queue("description", writer(written, "half a sentence")));
        act(() => result.current.queue("description", writer(written, "the whole sentence")));
        expect(written).toEqual([]);

        await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS)));

        expect(written).toEqual(["the whole sentence"]);
    });

    it("writes what is held when the panel closes, without waiting for the pause", async () => {
        const written: string[] = [];
        const { result } = renderHook(() => useAutosave(SETTLE_MS));

        act(() => result.current.queue("description", writer(written, "the last paragraph")));

        let kept = false;
        await act(async () => {
            kept = await result.current.flush();
        });

        expect(kept).toBe(true);
        expect(written).toEqual(["the last paragraph"]);
    });

    it("waits for a write that was already on its way", async () => {
        const written: string[] = [];
        const slow = heldOpen(written, "the description");
        const { result } = renderHook(() => useAutosave(SETTLE_MS));

        act(() => result.current.queue("description", slow.write));
        await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS)));
        expect(written).toEqual(["the description: sent"]);

        let closed = false;
        let closing!: Promise<boolean>;
        act(() => {
            closing = result.current.flush().then((kept) => {
                closed = true;
                return kept;
            });
        });
        await tick();
        // The panel is closing on a write the server has not answered yet, which is
        // the moment the edit used to be lost.
        expect(closed).toBe(false);

        await act(async () => {
            slow.answer(true);
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(await closing).toBe(true);
        expect(written).toEqual(["the description: sent", "the description: answered"]);
    });

    it("sends one write at a time, in the order they were typed", async () => {
        const written: string[] = [];
        const slow = heldOpen(written, "the name");
        const { result } = renderHook(() => useAutosave(SETTLE_MS));

        act(() => result.current.queue("name", slow.write));
        act(() => result.current.queue("description", writer(written, "the description")));
        await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS)));

        // The second write must not overtake the first: a task whose description
        // lands before the name it was typed after is a race, not a save.
        expect(written).toEqual(["the name: sent"]);

        await act(async () => {
            slow.answer(true);
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(written).toEqual(["the name: sent", "the name: answered", "the description"]);
    });

    it("keeps a refused write as an unsaved edit, and refuses to report it kept", async () => {
        const written: string[] = [];
        const { result } = renderHook(() => useAutosave(SETTLE_MS));

        act(() => result.current.queue("description", writer(written, "attempt", false)));

        let kept = true;
        await act(async () => {
            kept = await result.current.flush();
        });

        // False is what keeps the panel open with the text still in it.
        expect(kept).toBe(false);
        expect(written).toEqual(["attempt"]);

        // And the edit is still there to try again, rather than having been dropped
        // on the way out.
        await act(async () => void (await result.current.flush()));
        expect(written).toEqual(["attempt", "attempt"]);
    });

    it("drops what was held for a field the caller has a newer value for", async () => {
        const written: string[] = [];
        const { result } = renderHook(() => useAutosave(SETTLE_MS));

        act(() => result.current.queue("description", writer(written, "held description")));
        act(() => result.current.queue("name", writer(written, "held name")));

        await act(async () => void (await result.current.save("description", writer(written, "blurred description"))));

        expect(written).toEqual(["held name", "blurred description"]);

        // Nothing is left behind to fire afterwards and overwrite what was just saved.
        await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS)));
        expect(written).toEqual(["held name", "blurred description"]);
    });

    it("reads as busy from the keystroke until the write is answered", async () => {
        const written: string[] = [];
        const slow = heldOpen(written, "the description");
        const { result } = renderHook(() => useAutosave(SETTLE_MS));

        expect(result.current.busy).toBe(false);

        act(() => result.current.queue("description", slow.write));
        expect(result.current.busy).toBe(true);

        await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS)));
        expect(result.current.busy).toBe(true);

        await act(async () => {
            slow.answer(true);
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.busy).toBe(false);
    });
});
