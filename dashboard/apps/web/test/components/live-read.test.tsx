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
 * Rendered to static markup: the assertion is what the first paint contains, which
 * is exactly what a person sees before anything resolves.
 */

import { useCallback } from "react";
import { writeSnapshot } from "@/lib/snapshot-cache";
import { renderToStaticMarkup } from "react-dom/server";
import { useLiveRead } from "@/components/use-live-resource";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("paints the last reading it holds, before anything is fetched", () => {
        writeSnapshot("servers.usage.host-a", { cpuPercent: 62 });

        const markup = renderToStaticMarkup(<Panel cacheKey="servers.usage.host-a" />);

        expect(markup).toContain("62% cpu");
        expect(markup).not.toContain("loading");
    });

    it("says how old that reading is, rather than passing it off as this instant's", () => {
        writeSnapshot("servers.usage.host-a", { cpuPercent: 62 });
        vi.advanceTimersByTime(5 * 60_000);

        const markup = renderToStaticMarkup(<Panel cacheKey="servers.usage.host-a" />);

        expect(markup).toContain(`age ${5 * 60_000}`);
    });

    it("loads, rather than painting another subject's numbers, for one it has not read", () => {
        writeSnapshot("servers.usage.host-a", { cpuPercent: 62 });

        const markup = renderToStaticMarkup(<Panel cacheKey="servers.usage.host-b" />);

        expect(markup).toContain("loading");
        expect(markup).not.toContain("62% cpu");
        expect(markup).toContain("age unknown");
    });
});
