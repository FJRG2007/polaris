/**
 * Identical reads in flight share one answer: a thousand asks for one key at
 * once are one call, a failure is never kept, and a write's `forget` keeps a
 * later ask off a read that started before it.
 */

import { coalescer } from "@/lib/coalesce";
import { afterEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe("coalescer", () => {
    it("runs the work once for 1000 concurrent asks of one key", async () => {
        const shared = coalescer<string>();
        const gate = deferred<string>();
        const work = vi.fn(() => gate.promise);
        const asks = Array.from({ length: 1000 }, () => shared.run("setting:app", work));
        gate.resolve("polaris.example.test");
        const answers = await Promise.all(asks);
        expect(work).toHaveBeenCalledTimes(1);
        expect(new Set(answers)).toEqual(new Set(["polaris.example.test"]));
        expect(shared.size).toBe(0);
    });

    it("keeps different keys apart", async () => {
        const shared = coalescer<string>();
        const work = vi.fn(async (key: string) => key);
        const [a, b] = await Promise.all([
            shared.run("a", () => work("a")),
            shared.run("b", () => work("b"))
        ]);
        expect([a, b]).toEqual(["a", "b"]);
        expect(work).toHaveBeenCalledTimes(2);
    });

    it("runs again once the flight has landed when there is no TTL", async () => {
        const shared = coalescer<number>();
        let calls = 0;
        const work = async () => ++calls;
        expect(await shared.run("k", work)).toBe(1);
        expect(await shared.run("k", work)).toBe(2);
    });

    it("shares a failure with the callers in flight and never keeps it", async () => {
        const shared = coalescer<string>({ ttlMs: 60_000 });
        const gate = deferred<string>();
        const first = shared.run("k", () => gate.promise);
        const second = shared.run("k", () => Promise.resolve("unused"));
        gate.reject(new Error("database down"));
        await expect(first).rejects.toThrow("database down");
        await expect(second).rejects.toThrow("database down");
        await tick();
        expect(shared.size).toBe(0);
        expect(await shared.run("k", async () => "back")).toBe("back");
    });

    it("turns a synchronous throw into a rejection that is not kept", async () => {
        const shared = coalescer<string>();
        await expect(
            shared.run("k", () => {
                throw new Error("bad key");
            })
        ).rejects.toThrow("bad key");
        expect(shared.size).toBe(0);
    });

    it("reuses a settled answer for the TTL, then asks again", async () => {
        vi.useFakeTimers();
        const shared = coalescer<number>({ ttlMs: 1000 });
        let calls = 0;
        const work = async () => ++calls;
        expect(await shared.run("k", work)).toBe(1);
        vi.advanceTimersByTime(999);
        expect(await shared.run("k", work)).toBe(1);
        vi.advanceTimersByTime(1);
        expect(await shared.run("k", work)).toBe(2);
    });

    it("keeps an ask after forget off a read that started before it", async () => {
        const shared = coalescer<string>({ ttlMs: 60_000 });
        const before = deferred<string>();
        const stale = shared.run("k", () => before.promise);
        shared.forget("k");
        const after = shared.run("k", async () => "written");
        before.resolve("old");
        expect(await stale).toBe("old");
        expect(await after).toBe("written");
        await tick();
        // The read from before the write landed last and did not replace it.
        expect(await shared.run("k", async () => "unused")).toBe("written");
    });

    it("forgets every key when called without one", async () => {
        const shared = coalescer<string>({ ttlMs: 60_000 });
        await shared.run("a", async () => "a");
        await shared.run("b", async () => "b");
        shared.forget();
        expect(shared.size).toBe(0);
    });

    it("stays within maxKeys, dropping settled answers oldest first", async () => {
        const shared = coalescer<string>({ ttlMs: 60_000, maxKeys: 2 });
        await shared.run("a", async () => "a");
        await shared.run("b", async () => "b");
        await shared.run("c", async () => "c");
        expect(shared.size).toBe(2);
        const work = vi.fn(async () => "a again");
        expect(await shared.run("a", work)).toBe("a again");
        expect(work).toHaveBeenCalledTimes(1);
    });

    it("runs unshared rather than growing when every place is in flight", async () => {
        const shared = coalescer<string>({ maxKeys: 1 });
        const gate = deferred<string>();
        const held = shared.run("a", () => gate.promise);
        const work = vi.fn(async () => "b");
        expect(await shared.run("b", work)).toBe("b");
        expect(shared.size).toBe(1);
        gate.resolve("a");
        expect(await held).toBe("a");
    });
});
