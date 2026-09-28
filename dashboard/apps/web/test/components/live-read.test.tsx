// @vitest-environment jsdom

/**
 * What a cached read puts on screen before its first answer arrives.
 *
 * Every panel of tracked figures in Polaris - a server's CPU, a service's memory,
 * a host's containers - is a round trip behind a number, and the round trip is the
 * reason a page used to spend a second or two showing skeletons where figures had
 * been a moment earlier. `useLiveRead` is where that stopped: the reading is kept
 * in the tab, so the first paint is the last known one and the fetch behind it only
 * moves the numbers.
 *
 * That shortcut is only honest if the reading carries when it was taken, which is
 * what `updatedAt` is for and what the panels use to say "read 5m ago" instead of
 * letting an old figure pass for this instant's. Both are pinned here.
 *
 * Rendered in the browser and read back before any answer lands: that is exactly
 * what a person sees first. The kept reading is folded in after hydration, before
 * the paint, so the server's markup - which cannot see this tab's storage - is
 * never contradicted by the first render in the browser.
 *
 * What is kept is kept PER SHELF, which is why the snapshots here are written
 * under a key that names one. Two shelves ask the same panel the same question
 * and get different answers - this organization's servers, or somebody's own -
 * and before that was true of the key as well, switching shelves painted the
 * other one's figures out of the cache before any request left.
 */

import { useCallback } from "react";
import { writeSnapshot } from "@/lib/snapshot-cache";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useLiveRead } from "@/components/use-live-resource";
import { ShelfScopeProvider } from "@/components/shelf-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Where a reading taken on one shelf is kept. The shape `useLiveRead` writes:
 *  the shelf, then the subject the caller named. */
function kept(shelf: string, subject: string): string {
    return `${shelf}:${subject}`;
}

/** sessionStorage as the cache expects it; jsdom is not loaded for these tests. */
class MemoryStorage {
    private readonly items = new Map<string, string>();
    public get length(): number {
        return this.items.size;
    }
    public key(index: number): string | null {
        return [...this.items.keys()][index] ?? null;
    }
    public getItem(key: string): string | null {
        return this.items.get(key) ?? null;
    }
    public setItem(key: string, value: string): void {
        this.items.set(key, value);
    }
    public removeItem(key: string): void {
        this.items.delete(key);
    }
    public clear(): void {
        this.items.clear();
    }
}

/** The panel as a screen would mount it: inside a shelf. Defaults to the
 *  personal one, which is what a component rendered on its own gets. */
function onShelf(shelf: string, cacheKey: string): string {
    return render(
        <ShelfScopeProvider shelf={shelf}>
            <Panel cacheKey={cacheKey} />
        </ShelfScopeProvider>
    ).container.innerHTML;
}

function Panel({ cacheKey }: { cacheKey: string }) {
    // Never resolves: what is asserted is the paint before any answer lands.
    const load = useCallback(() => new Promise<{ cpuPercent: number }>(() => undefined), []);
    const { data, loading, updatedAt } = useLiveRead<{ cpuPercent: number }>({
        load,
        cacheKey,
        intervalMs: 30_000
    });
    return (
        <div>
            {loading ? <span>loading</span> : <span>{data?.cpuPercent}% cpu</span>}
            <span>age {updatedAt === null ? "unknown" : Date.now() - updatedAt}</span>
        </div>
    );
}

describe("A cached live read", () => {
    beforeEach(() => {
        vi.stubGlobal("sessionStorage", new MemoryStorage());
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("paints the last reading it holds, before anything is fetched", () => {
        writeSnapshot(kept("personal", "servers.usage.host-a"), { cpuPercent: 62 });

        const markup = onShelf("personal", "servers.usage.host-a");

        expect(markup).toContain("62% cpu");
        expect(markup).not.toContain("loading");
    });

    it("leaves it out of the server's markup, which hydration has to match", () => {
        writeSnapshot(kept("personal", "servers.usage.host-a"), { cpuPercent: 62 });

        const markup = renderToStaticMarkup(
            <ShelfScopeProvider shelf="personal">
                <Panel cacheKey="servers.usage.host-a" />
            </ShelfScopeProvider>
        );

        expect(markup).toContain("loading");
        expect(markup).not.toContain("62% cpu");
    });

    it("says how old that reading is, rather than passing it off as this instant's", () => {
        writeSnapshot(kept("personal", "servers.usage.host-a"), { cpuPercent: 62 });
        vi.advanceTimersByTime(5 * 60_000);

        const markup = onShelf("personal", "servers.usage.host-a");

        expect(markup).toContain(`age ${5 * 60_000}`);
    });

    it("loads, rather than painting another subject's numbers, for one it has not read", () => {
        writeSnapshot(kept("personal", "servers.usage.host-a"), { cpuPercent: 62 });

        const markup = onShelf("personal", "servers.usage.host-b");

        expect(markup).toContain("loading");
        expect(markup).not.toContain("62% cpu");
        expect(markup).toContain("age unknown");
    });

    it("never paints another shelf's reading of the same subject", () => {
        writeSnapshot(kept("personal", "servers.usage.host-a"), { cpuPercent: 62 });

        const markup = onShelf("acme", "servers.usage.host-a");

        expect(markup).toContain("loading");
        expect(markup).not.toContain("62% cpu");
    });
});

/**
 * Whether what is on screen is the kept copy or this visit's answer.
 *
 * A kept reading may describe something that has since changed, so a screen
 * lets nothing act on it - no button, no link, no menu - until `kept` turns
 * false. And a first read that fails over a kept copy has to be told apart from
 * a refresh that failed over this visit's answer: before the snapshot existed
 * that screen had nothing to show, and it must still be able to show exactly
 * that.
 */
describe("Whether a live read is still showing the kept copy", () => {
    beforeEach(() => {
        vi.stubGlobal("sessionStorage", new MemoryStorage());
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    /** The hook over reads the test answers, or refuses, by hand. */
    function mountReads(subject: string) {
        const answers: Array<{ resolve: (value: number) => void; reject: (reason: Error) => void }> = [];
        const load = () =>
            new Promise<number>((resolve, reject) => {
                answers.push({ resolve, reject });
            });
        const hook = renderHook(
            ({ cacheKey }: { cacheKey: string }) => useLiveRead<number>({ load, cacheKey }),
            { initialProps: { cacheKey: subject } }
        );
        return { answers, ...hook };
    }

    it("is true while the kept reading is on screen, and false once this visit's answer lands", async () => {
        writeSnapshot(kept("personal", "kept.a"), 62);
        const { answers, result } = mountReads("kept.a");

        expect(result.current.data).toBe(62);
        expect(result.current.kept).toBe(true);

        await act(async () => answers[0]!.resolve(62));

        expect(result.current.data).toBe(62);
        expect(result.current.kept).toBe(false);
    });

    it("is false when nothing was kept, before and after the answer", async () => {
        const { answers, result } = mountReads("kept.a");

        expect(result.current.loading).toBe(true);
        expect(result.current.kept).toBe(false);

        await act(async () => answers[0]!.resolve(40));

        expect(result.current.data).toBe(40);
        expect(result.current.kept).toBe(false);
    });

    it("stays true when this visit's first read fails, so the screen can show the failure it showed before", async () => {
        writeSnapshot(kept("personal", "kept.a"), 62);
        const { answers, result } = mountReads("kept.a");

        await act(async () => answers[0]!.reject(new Error("The device did not answer")));

        expect(result.current.kept).toBe(true);
        expect(result.current.stale).toBe("The device did not answer");
    });

    it("is false after a refresh fails over this visit's answer, which is only stale", async () => {
        writeSnapshot(kept("personal", "kept.a"), 62);
        const { answers, result } = mountReads("kept.a");
        await act(async () => answers[0]!.resolve(63));

        act(() => result.current.refresh());
        await act(async () => answers[1]!.reject(new Error("The device did not answer")));

        expect(result.current.data).toBe(63);
        expect(result.current.kept).toBe(false);
        expect(result.current.stale).toBe("The device did not answer");
    });

    it("is false once a value is put on screen by hand", () => {
        writeSnapshot(kept("personal", "kept.a"), 62);
        const { result } = mountReads("kept.a");

        act(() => result.current.replace(70));

        expect(result.current.data).toBe(70);
        expect(result.current.kept).toBe(false);
    });

    it("follows the subject: true for one with a kept reading, false for one without", async () => {
        writeSnapshot(kept("personal", "kept.b"), 10);
        const { answers, result, rerender } = mountReads("kept.a");
        await act(async () => answers[0]!.resolve(1));

        rerender({ cacheKey: "kept.b" });
        expect(result.current.data).toBe(10);
        expect(result.current.kept).toBe(true);

        rerender({ cacheKey: "kept.c" });
        expect(result.current.data).toBe(null);
        expect(result.current.kept).toBe(false);
    });
});
