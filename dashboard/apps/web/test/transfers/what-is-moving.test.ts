// @vitest-environment jsdom
/**
 * The list of what is going up and coming down.
 *
 * It exists because every screen in Polaris that sends or receives a file used to
 * say the same nothing while it happened: a small file is instant and nobody
 * noticed, a large one is a button that looks pressed and a screen that looks
 * stuck, and what people do then is press it again.
 *
 * Three things are pinned here, and each of them is a way of not lying to the
 * reader. A transfer with no known size has no percentage - a bar that fills at a
 * rate nobody chose says "this much is left" and is guessing. An estimate is not
 * offered in the first moments, when it would be a wild number from two chunks and
 * a connection. And a finished transfer takes itself off while a failed one stays,
 * because the failure is the only place its reason is written.
 *
 * In a browser environment on purpose: what takes a finished transfer off the list
 * is a timer on `window`, and a store that quietly kept every transfer forever
 * where there is no window is the failure this would otherwise not see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    beginTransfer,
    clearSettledTransfers,
    clearTransfer,
    transferFraction,
    transfersNow,
    transferSecondsLeft
} from "@/components/transfers/transfer-store";

beforeEach(() => {
    vi.useFakeTimers();
    for (const transfer of transfersNow()) clearTransfer(transfer.id);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("one transfer's life", () => {
    it("starts as waiting, because the first seconds are all connection", () => {
        const handle = beginTransfer({ name: "holiday.mp4", way: "up", total: 1000 });
        const [transfer] = transfersNow();
        expect(transfer!.id).toBe(handle.id);
        expect(transfer!.state).toBe("waiting");
        expect(transfer!.moved).toBe(0);
    });

    it("is moving from the first byte, and done at the end", () => {
        const handle = beginTransfer({ name: "holiday.mp4", way: "up", total: 1000 });
        handle.moved(250);
        expect(transfersNow()[0]!.state).toBe("moving");
        expect(transferFraction(transfersNow()[0]!)).toBeCloseTo(0.25);

        handle.done();
        expect(transfersNow()[0]!.state).toBe("done");
        // Filled, rather than left at whatever the last chunk reported: a finished
        // transfer showing 98% is a transfer somebody keeps waiting for.
        expect(transferFraction(transfersNow()[0]!)).toBe(1);
    });

    it("takes itself off the list once it has been read", () => {
        const handle = beginTransfer({ name: "holiday.mp4", way: "up", total: 10 });
        handle.done();
        expect(transfersNow()).toHaveLength(1);
        vi.advanceTimersByTime(10_000);
        expect(transfersNow()).toHaveLength(0);
    });

    it("stays when it failed, with the reason on it", () => {
        const handle = beginTransfer({ name: "holiday.mp4", way: "up", total: 10 });
        handle.failed("holiday.mp4 is bigger than 200 MB");
        vi.advanceTimersByTime(60_000);
        expect(transfersNow()).toHaveLength(1);
        expect(transfersNow()[0]!.error).toBe("holiday.mp4 is bigger than 200 MB");
        // And no longer offers to stop something that has stopped.
        expect(transfersNow()[0]!.stop).toBeUndefined();
    });

    it("can be called off while it is still going", () => {
        const stop = vi.fn();
        const handle = beginTransfer({ name: "holiday.mp4", way: "up", total: 10, stop });
        transfersNow()[0]!.stop!();
        expect(stop).toHaveBeenCalled();
        handle.stopped();
        expect(transfersNow()[0]!.state).toBe("stopped");
    });

    it("learns its size later, which is what a download does", () => {
        // An upload always knows what it weighs; a download only knows once the
        // server has said so, and until then there is no percentage to draw.
        const handle = beginTransfer({ name: "report.pdf", way: "down" });
        expect(transferFraction(transfersNow()[0]!)).toBeNull();
        handle.moved(500, 2000);
        expect(transferFraction(transfersNow()[0]!)).toBeCloseTo(0.25);
    });
});

describe("what is left", () => {
    it("is not guessed from the first moment", () => {
        const handle = beginTransfer({ name: "holiday.mp4", way: "up", total: 1_000_000 });
        handle.moved(1000);
        expect(transferSecondsLeft(transfersNow()[0]!, Date.now() + 200)).toBeNull();
    });

    it("comes from the rate once there is a rate", () => {
        const handle = beginTransfer({ name: "holiday.mp4", way: "up", total: 1000 });
        handle.moved(250);
        // A quarter in four seconds: twelve to go.
        expect(transferSecondsLeft(transfersNow()[0]!, Date.now() + 4000)).toBe(12);
    });

    it("says nothing at all where the size is not known", () => {
        const handle = beginTransfer({ name: "report.pdf", way: "down" });
        handle.moved(5000);
        expect(transferSecondsLeft(transfersNow()[0]!, Date.now() + 10_000)).toBeNull();
    });
});

describe("clearing the list", () => {
    it("takes the settled ones and leaves whatever is still going", () => {
        const going = beginTransfer({ name: "one.mp4", way: "up", total: 10 });
        going.moved(1);
        beginTransfer({ name: "two.mp4", way: "up", total: 10 }).failed("nope");

        clearSettledTransfers();
        expect(transfersNow().map((transfer) => transfer.name)).toEqual(["one.mp4"]);
    });
});
