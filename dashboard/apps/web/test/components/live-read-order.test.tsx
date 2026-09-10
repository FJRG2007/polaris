// @vitest-environment jsdom

/**
 * Which answer a cached live read keeps when its reads land out of order.
 *
 * Reads overlap: a poll fires while the last one is still out, and a screen that
 * writes asks again after every write. An answer that left earlier can land
 * later, and putting it on screen - and in the kept copy - brings back what a
 * newer answer, or a write, has since moved: a deleted DNS record back in its
 * table, until the next read.
 *
 * - **An answer older than one already shown is dropped.**
 * - **An answer that left before a value was put on screen is dropped.**
 * - **An older answer still lands while nothing newer has**, so a device whose
 *   reads take longer than the poll still moves.
 */

import { readSnapshot } from "@/lib/snapshot-cache";
import { useLiveRead } from "@/components/use-live-resource";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SUBJECT = "order.test";

/** A promise the test settles by hand, so the order answers land in is the test's. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

/** The hook over reads that answer only when told to, in the order they left. */
function mountReads(count: number) {
    const answers = Array.from({ length: count }, () => deferred<string>());
    let asked = 0;
    const load = () => answers[asked++]!.promise;
    const { result } = renderHook(() => useLiveRead<string>({ load, cacheKey: SUBJECT }));
    return { answers, result };
}

function kept(): string | undefined {
    return readSnapshot<string>(`personal:${SUBJECT}`, 60_000)?.value;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => cleanup());

describe("A cached live read with answers out of order", () => {
    it("drops an answer older than one already shown", async () => {
        const { answers, result } = mountReads(2);
        act(() => result.current.refresh());

        await act(async () => answers[1]!.resolve("newer"));
        await act(async () => answers[0]!.resolve("older"));

        expect(result.current.data).toBe("newer");
        expect(kept()).toBe("newer");
        expect(result.current.refreshing).toBe(false);
    });

    it("drops an answer that left before a value was put on screen", async () => {
        const { answers, result } = mountReads(1);
        act(() => result.current.replace("written"));

        await act(async () => answers[0]!.resolve("from before the write"));

        expect(result.current.data).toBe("written");
        expect(kept()).toBe("written");
        expect(result.current.refreshing).toBe(false);
    });

    it("still shows an older answer while nothing newer has landed", async () => {
        const { answers, result } = mountReads(2);
        act(() => result.current.refresh());

        await act(async () => answers[0]!.resolve("first"));
        expect(result.current.data).toBe("first");
        expect(result.current.refreshing).toBe(true);

        await act(async () => answers[1]!.resolve("second"));
        expect(result.current.data).toBe("second");
        expect(result.current.refreshing).toBe(false);
    });
});
