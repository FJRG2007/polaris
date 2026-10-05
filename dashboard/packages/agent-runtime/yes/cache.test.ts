import { hashKey, TtlLru } from "./cache.ts";
import { describe, expect, it } from "vitest";

describe("hashKey", () => {
    it("is the same for the same data in any key or item order", () => {
        expect(hashKey({ owner: "o", name: "r", pullNumber: 1 })).toBe(
            hashKey({ pullNumber: 1, name: "r", owner: "o" })
        );
        expect(hashKey({ tags: ["a", "b"] })).toBe(hashKey({ tags: ["b", "a"] }));
        expect(hashKey(new Set([1, 2]))).toBe(hashKey(new Set([2, 1])));
        expect(
            hashKey(
                new Map([
                    ["a", 1],
                    ["b", 2]
                ])
            )
        ).toBe(
            hashKey(
                new Map([
                    ["b", 2],
                    ["a", 1]
                ])
            )
        );
    });

    it("tells apart values that only look alike", () => {
        const keys = [
            hashKey({ n: 1 }),
            hashKey({ n: "1" }),
            hashKey({ n: [1] }),
            hashKey({ n: null }),
            hashKey({ n: undefined }),
            hashKey({}),
            hashKey(["a,b"]),
            hashKey(["a", "b"]),
            hashKey(new Date(0)),
            hashKey({ pullNumber: 1 }),
            hashKey({ pullNumber: 2 })
        ];
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("refuses what has no meaning as a key", () => {
        expect(() => hashKey({ fn: () => 1 })).toThrow(/function/);
        expect(() => hashKey(Symbol("s"))).toThrow(/symbol/);
        expect(() => hashKey(new (class Client {})())).toThrow(/Client instance/);
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(() => hashKey(cycle)).toThrow(/circular/);
    });

    it("accepts the same object twice when it is not a cycle", () => {
        const shared = { a: 1 };
        expect(() => hashKey({ x: shared, y: shared })).not.toThrow();
    });
});

describe("TtlLru", () => {
    const clock = () => {
        let now = 0;
        return { now: () => now, advance: (ms: number) => (now += ms) };
    };

    it("drops the least recently read entry past its size", () => {
        const time = clock();
        const cache = new TtlLru<string, number>(2, 1_000, time.now);
        cache.set("a", 1).set("b", 2);
        expect(cache.get("a")).toBe(1);
        cache.set("c", 3);
        expect(cache.has("b")).toBe(false);
        expect(cache.get("a")).toBe(1);
        expect(cache.get("c")).toBe(3);
    });

    it("expires an entry ttl after it was set, however often it is read", () => {
        const time = clock();
        const cache = new TtlLru<string, number>(10, 1_000, time.now);
        cache.set("a", 1);
        time.advance(600);
        expect(cache.get("a")).toBe(1);
        time.advance(400);
        expect(cache.get("a")).toBeUndefined();
        expect(cache.has("a")).toBe(false);
    });

    it("iterates live entries only, and deletes and clears", () => {
        const time = clock();
        const cache = new TtlLru<string, number>(10, 1_000, time.now);
        cache.set("old", 1);
        time.advance(900);
        cache.set("new", 2).set("gone", 3);
        expect(cache.delete("gone")).toBe(true);
        time.advance(200);
        expect([...cache]).toEqual([["new", 2]]);
        cache.clear();
        expect([...cache]).toEqual([]);
    });

    it("refuses a size or ttl that would cache nothing", () => {
        expect(() => new TtlLru(0, 1_000)).toThrow();
        expect(() => new TtlLru(1, 0)).toThrow();
    });
});
