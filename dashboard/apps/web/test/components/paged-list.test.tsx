// @vitest-environment jsdom

/**
 * A list read a page at a time, and drawn a screenful at a time.
 *
 * What somebody scrolling a long list depends on: the next page lands under the
 * rows already there, a new search starts again from the top, an answer to a
 * search they have since changed never lands on top of the current one, a
 * refresh keeps everything they had scrolled to, and the first paint is a list
 * rather than an empty table waiting for a script.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, renderHook, waitFor } from "@testing-library/react";
import { VirtualTableBody } from "@/components/paged-list/virtual-table-body";
import { usePagedList, type ListPage } from "@/components/paged-list/use-paged-list";

type Params = { query: string };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

describe("usePagedList", () => {
    it("adds the next page under the first, and stops at the end", async () => {
        const load = vi.fn(async (cursor: string | null) =>
            cursor === "p2" ? { items: ["c", "d"], next: null } : { items: [], next: null }
        );
        // Held once, as a server-rendered prop is: a new one is the server redrawing.
        const first: ListPage<string> = { items: ["a", "b"], next: "p2" };
        const { result } = renderHook(() =>
            usePagedList<string, Params>({
                first,
                params: { query: "" },
                initialParams: { query: "" },
                load
            })
        );
        act(() => result.current.loadMore());
        await waitFor(() => expect(result.current.items).toEqual(["a", "b", "c", "d"]));
        expect(result.current.hasMore).toBe(false);
        act(() => result.current.loadMore());
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("starts again from the top for a new search, and drops the answer to an old one", async () => {
        const slow = deferred<ListPage<string>>();
        const load = vi.fn((_cursor: string | null, params: Params) =>
            params.query === "an" ? slow.promise : Promise.resolve({ items: ["ana"], next: null })
        );
        const first: ListPage<string> = { items: ["a", "b"], next: "p2" };
        const { result, rerender } = renderHook(({ query }) =>
            usePagedList<string, Params>({ first, params: { query }, initialParams: { query: "" }, load }), {
            initialProps: { query: "" }
        });
        rerender({ query: "an" });
        rerender({ query: "ana" });
        await waitFor(() => expect(result.current.items).toEqual(["ana"]));
        // The answer to "an" arrives late, and is not what is on screen.
        await act(async () => slow.resolve({ items: ["anders", "anna"], next: null }));
        expect(result.current.items).toEqual(["ana"]);
        expect(load.mock.calls.map((call) => call[0])).toEqual([null, null]);
    });

    it("reads again everything on screen in one request when the server redraws", async () => {
        const load = vi.fn(async (cursor: string | null, _params: Params, limit?: number) =>
            cursor === "p2"
                ? { items: ["c", "d"], next: "p3" }
                : { items: ["a", "b", "c", "d"].slice(0, limit), next: "p3" }
        );
        const { result, rerender } = renderHook(({ first }) =>
            usePagedList<string, Params>({ first, params: { query: "" }, initialParams: { query: "" }, load }), {
            initialProps: { first: { items: ["a", "b"], next: "p2" } as ListPage<string> }
        });
        act(() => result.current.loadMore());
        await waitFor(() => expect(result.current.items).toHaveLength(4));
        rerender({ first: { items: ["a", "b"], next: "p2" } });
        await waitFor(() => expect(load).toHaveBeenLastCalledWith(null, { query: "" }, 4));
        expect(result.current.items).toEqual(["a", "b", "c", "d"]);
    });

    it("says when a page could not be read, and keeps what it had", async () => {
        const first: ListPage<string> = { items: ["a"], next: "p2" };
        const { result } = renderHook(() =>
            usePagedList<string, Params>({
                first,
                params: { query: "" },
                initialParams: { query: "" },
                load: async () => ({ error: "nope" })
            })
        );
        act(() => result.current.loadMore());
        await waitFor(() => expect(result.current.error).toBe("nope"));
        expect(result.current.items).toEqual(["a"]);
        expect(result.current.hasMore).toBe(true);
    });

    it("drops the old search's rows when the new one fails, and retries the new one", async () => {
        let failing = true;
        const load = vi.fn(async (cursor: string | null, params: Params) =>
            params.query === "an" && failing ? { error: "nope" } : { items: [`${params.query}:${cursor}`], next: null }
        );
        const first: ListPage<string> = { items: ["a", "b"], next: "p2" };
        const { result, rerender } = renderHook(({ query }) =>
            usePagedList<string, Params>({ first, params: { query }, initialParams: { query: "" }, load }), {
            initialProps: { query: "" }
        });
        rerender({ query: "an" });
        await waitFor(() => expect(result.current.error).toBe("nope"));
        expect(result.current.items).toEqual([]);
        expect(result.current.hasMore).toBe(false);
        act(() => result.current.loadMore());
        expect(load).toHaveBeenCalledTimes(1);
        failing = false;
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.items).toEqual(["an:null"]));
        expect(result.current.error).toBeNull();
        expect(load.mock.calls.map((call) => [call[0], call[1].query])).toEqual([
            [null, "an"],
            [null, "an"]
        ]);
    });

    it("retries a failed next page from the cursor it failed on", async () => {
        let failing = true;
        const load = vi.fn(async (cursor: string | null) =>
            failing ? { error: "nope" } : { items: [`after-${cursor}`], next: null }
        );
        const first: ListPage<string> = { items: ["a"], next: "p2" };
        const { result } = renderHook(() =>
            usePagedList<string, Params>({ first, params: { query: "" }, initialParams: { query: "" }, load })
        );
        act(() => result.current.loadMore());
        await waitFor(() => expect(result.current.error).toBe("nope"));
        failing = false;
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.items).toEqual(["a", "after-p2"]));
    });
});

describe("VirtualTableBody", () => {
    const items = Array.from({ length: 5000 }, (_, index) => `row-${index}`);

    it("draws a screenful on the server, not five thousand rows and not none", () => {
        const html = renderToStaticMarkup(
            <table>
                <VirtualTableBody
                    items={items}
                    estimate={50}
                    colSpan={1}
                    getKey={(item) => item}
                    renderRow={(item, row) => (
                        <tr key={item} {...row}>
                            <td>{item}</td>
                        </tr>
                    )}
                />
            </table>
        );
        const drawn = html.match(/row-\d+/g) ?? [];
        expect(drawn.length).toBeGreaterThan(10);
        expect(drawn.length).toBeLessThan(60);
        expect(drawn[0]).toBe("row-0");
    });
});
