import * as yes from "./index.ts";
import { describe, expect, it } from "vitest";

// The cache behaviour every cached op relies on, written against the public
// `yes.op` surface so it holds whatever stores and keys the entries.
describe("yes.op cache", () => {
    const counted = () => {
        const calls: unknown[] = [];
        const fn = async (key: { owner: string; name: string; pullNumber: number }) => {
            calls.push(key);
            return `result ${calls.length}`;
        };
        return { calls, fn };
    };

    it("answers the same request from the cache, whatever order its keys arrive in", async () => {
        const { calls, fn } = counted();
        const cached = yes.op(fn, { ttl: 60_000, cacheHit: null, cacheMiss: null });
        expect(await cached({ owner: "o", name: "r", pullNumber: 1 })).toBe("result 1");
        expect(await cached({ pullNumber: 1, name: "r", owner: "o" })).toBe("result 1");
        expect(await cached({ owner: "o", name: "r", pullNumber: 2 })).toBe("result 2");
        expect(calls).toHaveLength(2);
        expect(cached.has({ name: "r", owner: "o", pullNumber: 2 })).toBe(true);
    });

    it("forgets an entry once its ttl has passed", async () => {
        // Real time, not fake timers: a cache may read its own clock.
        const { calls, fn } = counted();
        const cached = yes.op(fn, { ttl: 200, cacheHit: null, cacheMiss: null });
        await cached({ owner: "o", name: "r", pullNumber: 1 });
        await cached({ owner: "o", name: "r", pullNumber: 1 });
        expect(calls).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(cached.has({ owner: "o", name: "r", pullNumber: 1 })).toBe(false);
        await cached({ owner: "o", name: "r", pullNumber: 1 });
        expect(calls).toHaveLength(2);
    });

    it("keeps at most maxItems entries, dropping the least recently used", async () => {
        const { calls, fn } = counted();
        const cached = yes.op(fn, { ttl: 60_000, maxItems: 2, cacheHit: null, cacheMiss: null });
        const a = { owner: "o", name: "a", pullNumber: 1 };
        const b = { owner: "o", name: "b", pullNumber: 1 };
        const c = { owner: "o", name: "c", pullNumber: 1 };
        await cached(a);
        await cached(b);
        await cached(a);
        await cached(c);
        expect(cached.has(a)).toBe(true);
        expect(cached.has(b)).toBe(false);
        expect(cached.has(c)).toBe(true);
        expect(calls).toHaveLength(3);
    });

    it("clears one entry, all of them, or those a predicate picks", async () => {
        const { fn } = counted();
        const cached = yes.op(fn, { ttl: 60_000, cacheHit: null, cacheMiss: null });
        const keys = [1, 2, 3].map((pullNumber) => ({ owner: "o", name: "r", pullNumber }));
        for (const key of keys) await cached(key);
        cached.clear(keys[0]);
        expect(cached.has(keys[0]!)).toBe(false);
        expect(cached.invalidate((key) => key.pullNumber === 2)).toBe(1);
        expect(cached.has(keys[1]!)).toBe(false);
        expect(cached.has(keys[2]!)).toBe(true);
        cached.clear();
        expect(cached.has(keys[2]!)).toBe(false);
    });
});
