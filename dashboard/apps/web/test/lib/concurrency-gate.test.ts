/**
 * The gate that keeps outside lookups off most of the server's thread pool, and
 * the shared flight that makes a burst of asks for one thing a single ask.
 */

import { describe, expect, it } from "vitest";
import { createGate, createSharedFlight } from "@/lib/concurrency-gate";

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

describe("createGate", () => {
    it("never runs more than its places at once, and runs the rest in order", async () => {
        const gate = createGate(2);
        const holds = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
        const started: number[] = [];
        const runs = holds.map((hold, index) =>
            gate.run(async () => {
                started.push(index);
                await hold.promise;
                return index;
            })
        );
        await tick();
        expect(started).toEqual([0, 1]);
        expect(gate.active).toBe(2);
        expect(gate.waiting).toBe(2);

        holds[1]!.resolve();
        await tick();
        expect(started).toEqual([0, 1, 2]);
        expect(gate.active).toBe(2);

        holds[0]!.resolve();
        holds[2]!.resolve();
        holds[3]!.resolve();
        await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3]);
        expect(gate.active).toBe(0);
        expect(gate.waiting).toBe(0);
    });

    it("frees a place when a task fails", async () => {
        const gate = createGate(1);
        await expect(gate.run(async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
        await expect(gate.run(async () => "next")).resolves.toBe("next");
        expect(gate.active).toBe(0);
    });

    it("takes a waiting task out of the line when its signal aborts", async () => {
        const gate = createGate(1);
        const hold = deferred<void>();
        const first = gate.run(() => hold.promise);
        const leaving = new AbortController();
        let ran = false;
        const second = gate.run(async () => {
            ran = true;
        }, leaving.signal);
        const third = gate.run(async () => "third");
        expect(gate.waiting).toBe(2);

        leaving.abort(new Error("gone"));
        await expect(second).rejects.toThrow("gone");
        expect(gate.waiting).toBe(1);

        hold.resolve();
        await first;
        await expect(third).resolves.toBe("third");
        expect(ran).toBe(false);
        expect(gate.active).toBe(0);
    });

    it("refuses a gate with no places", () => {
        expect(() => createGate(0)).toThrow();
    });
});

describe("createSharedFlight", () => {
    it("answers a second ask for the same key with the first one's run", async () => {
        const shared = createSharedFlight<string>();
        const hold = deferred<string>();
        let runs = 0;
        const task = () => {
            runs += 1;
            return hold.promise;
        };
        const first = shared("example.com", task);
        const second = shared("example.com", task);
        expect(runs).toBe(1);
        hold.resolve("mark");
        await expect(Promise.all([first, second])).resolves.toEqual(["mark", "mark"]);
    });

    it("abandons a run only once every caller has stopped waiting", async () => {
        const shared = createSharedFlight<string>();
        const hold = deferred<string>();
        let seen: AbortSignal | undefined;
        const task = (signal: AbortSignal) => {
            seen = signal;
            return hold.promise;
        };
        const one = new AbortController();
        const two = new AbortController();
        const first = shared("a", task, one.signal);
        const second = shared("a", task, two.signal);
        await tick();

        one.abort(new Error("first gave up"));
        await expect(first).rejects.toThrow("first gave up");
        expect(seen?.aborted).toBe(false);

        two.abort(new Error("second gave up"));
        await expect(second).rejects.toThrow("second gave up");
        expect(seen?.aborted).toBe(true);

        let fresh = 0;
        const again = shared("a", async () => {
            fresh += 1;
            return "again";
        });
        await expect(again).resolves.toBe("again");
        expect(fresh).toBe(1);
        hold.resolve("late");
    });

    it("starts again once the first run has settled, and keeps keys apart", async () => {
        const shared = createSharedFlight<number>();
        let runs = 0;
        const task = async () => (runs += 1);
        await shared("a", task);
        await shared("a", task);
        await shared("b", task);
        expect(runs).toBe(3);
    });
});
