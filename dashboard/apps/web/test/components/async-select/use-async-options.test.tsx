// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropAsyncOptions, useAsyncOptions, type AsyncLoad, type AsyncPage } from "@polaris/ui";

interface Row {
    readonly id: string;
}

/** A load whose answers the test hands out, one call at a time. */
function controlledLoad() {
    const calls: {
        query: string;
        cursor: string | null;
        signal: AbortSignal;
        answer: (page: AsyncPage<Row>) => Promise<void>;
        fail: () => Promise<void>;
    }[] = [];
    const load: AsyncLoad<Row> = ({ query, cursor, signal }) =>
        new Promise((resolve, reject) => {
            calls.push({
                query,
                cursor,
                signal,
                answer: async (page) => {
                    await act(async () => resolve(page));
                },
                fail: async () => {
                    await act(async () => reject(new Error("down")));
                }
            });
        });
    return { load, calls };
}

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

function mount(load: AsyncLoad<Row>, cacheKey = "test") {
    return renderHook(
        ({ open, query }: { open: boolean; query: string }) =>
            useAsyncOptions({ load, cacheKey, open, query }),
        { initialProps: { open: false, query: "" } }
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    dropAsyncOptions();
});
afterEach(() => vi.useRealTimers());

describe("useAsyncOptions", () => {
    it("reads nothing until it opens, then only the first page", async () => {
        const { load, calls } = controlledLoad();
        const view = mount(load);
        expect(calls).toHaveLength(0);

        view.rerender({ open: true, query: "" });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ query: "", cursor: null });
        expect(view.result.current.loading).toBe(true);

        await calls[0]!.answer({ items: rows("a", "b"), next: "c1" });
        expect(view.result.current.items).toEqual(rows("a", "b"));
        expect(view.result.current.loading).toBe(false);
        expect(view.result.current.hasMore).toBe(true);
    });

    it("sends the search to the server once typing pauses, not per keystroke", async () => {
        const { load, calls } = controlledLoad();
        const view = mount(load);
        view.rerender({ open: true, query: "" });
        await calls[0]!.answer({ items: rows("a"), next: null });

        view.rerender({ open: true, query: "w" });
        view.rerender({ open: true, query: "we" });
        view.rerender({ open: true, query: "web" });
        await act(async () => vi.advanceTimersByTime(100));
        expect(calls).toHaveLength(1);

        await act(async () => vi.advanceTimersByTime(250));
        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({ query: "web", cursor: null });
    });

    it("asks for the next page with the cursor the last one ended on", async () => {
        const { load, calls } = controlledLoad();
        const view = mount(load);
        view.rerender({ open: true, query: "" });
        await calls[0]!.answer({ items: rows("a", "b"), next: "c1" });

        act(() => view.result.current.loadMore());
        expect(calls[1]).toMatchObject({ query: "", cursor: "c1" });
        // A second ask while one is on its way is not another request.
        act(() => view.result.current.loadMore());
        expect(calls).toHaveLength(2);

        await calls[1]!.answer({ items: rows("c"), next: null });
        expect(view.result.current.items).toEqual(rows("a", "b", "c"));
        expect(view.result.current.hasMore).toBe(false);
    });

    it("aborts and drops the answer to a question nobody is asking any more", async () => {
        const { load, calls } = controlledLoad();
        const view = mount(load);
        view.rerender({ open: true, query: "" });
        view.rerender({ open: true, query: "db" });
        await act(async () => vi.advanceTimersByTime(300));
        expect(calls).toHaveLength(2);
        expect(calls[0]!.signal.aborted).toBe(true);

        await calls[1]!.answer({ items: rows("db-1"), next: null });
        // The older answer arrives last, and is not painted over the current one.
        await calls[0]!.answer({ items: rows("stale"), next: null });
        expect(view.result.current.items).toEqual(rows("db-1"));
    });

    it("draws a cached first page at once on reopening, with no skeleton", async () => {
        const { load, calls } = controlledLoad();
        const view = mount(load);
        view.rerender({ open: true, query: "" });
        await calls[0]!.answer({ items: rows("a"), next: null });

        view.rerender({ open: false, query: "" });
        view.rerender({ open: true, query: "" });
        expect(view.result.current.loading).toBe(false);
        expect(view.result.current.items).toEqual(rows("a"));
        // Fresh within the TTL: not read again.
        expect(calls).toHaveLength(1);

        // Past it, read again behind the cached rows.
        view.rerender({ open: false, query: "" });
        await act(async () => vi.advanceTimersByTime(31_000));
        view.rerender({ open: true, query: "" });
        expect(view.result.current.items).toEqual(rows("a"));
        expect(calls).toHaveLength(2);
        await calls[1]!.answer({ items: rows("a", "b"), next: null });
        expect(view.result.current.items).toEqual(rows("a", "b"));
    });

    it("says a first page failed and asks it again on retry", async () => {
        const { load, calls } = controlledLoad();
        const view = mount(load);
        view.rerender({ open: true, query: "" });
        await calls[0]!.fail();
        expect(view.result.current.failed).toBe(true);
        expect(view.result.current.items).toEqual([]);

        act(() => view.result.current.retry());
        expect(calls).toHaveLength(2);
        await calls[1]!.answer({ items: rows("a"), next: null });
        expect(view.result.current.failed).toBe(false);
        expect(view.result.current.items).toEqual(rows("a"));
    });
});
