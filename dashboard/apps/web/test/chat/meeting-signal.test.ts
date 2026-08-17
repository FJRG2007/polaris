/**
 * The relay between two browsers in a call.
 *
 * Three things are asserted and each is load-bearing. A signal reaches only the
 * participant it is addressed to - the whole of what stops one peer's connection
 * details from being handed to a third browser, since the payload is opaque to
 * this server and there is nothing else in the way. An event about the call
 * reaches everybody. And a signal nobody was listening for is *held*.
 *
 * That last one is not a nicety. The browser joining second holds a seat before
 * it has opened the stream it listens on, so the first browser's offer is
 * routinely addressed to somebody not yet at the door; dropping it means the
 * call never connects and nothing retries, because the sender has no reason to
 * think it failed. These tests are the regression for two people sitting in a
 * call seeing each other's names and hearing nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    HOLD_MAX,
    publishMeetingEvent,
    publishSignal,
    subscribeMeetingEvents,
    subscribeSignals,
    takeHeldSignals,
    MAX_SIGNAL_BYTES
} from "../../src/lib/chat/meeting-signal";

let stop: (() => void)[] = [];

/** A listener that says it took the signal, which is what a stream serving that
 *  participant does. */
function taking(spy: (signal: unknown) => void): () => void {
    return subscribeSignals((signal) => {
        spy(signal);
        return true;
    });
}

beforeEach(() => {
    for (const off of stop) off();
    stop = [];
    // Anything a previous test left on the shelf, so one holding test cannot
    // hand its leftovers to the next.
    takeHeldSignals("m1", "b");
    takeHeldSignals("m1", "c");
});

describe("meeting signalling", () => {
    it("delivers to every listener, which is what lets each filter for itself", () => {
        const heard = vi.fn();
        stop.push(taking(heard));

        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "{}" });

        expect(heard).toHaveBeenCalledWith({
            meetingId: "m1",
            fromId: "a",
            toId: "b",
            payload: "{}"
        });
    });

    it("keeps going when one listener throws", () => {
        const second = vi.fn();
        stop.push(
            subscribeSignals(() => {
                throw new Error("that connection is gone");
            })
        );
        stop.push(taking(second));

        expect(() =>
            publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "{}" })
        ).not.toThrow();
        expect(second).toHaveBeenCalled();
    });

    it("stops delivering once unsubscribed", () => {
        const heard = vi.fn();
        const off = taking(heard);
        off();

        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "{}" });

        expect(heard).not.toHaveBeenCalled();
    });

    it("carries events about the call separately from signals", () => {
        const signals = vi.fn();
        const events = vi.fn();
        stop.push(subscribeSignals(signals));
        stop.push(subscribeMeetingEvents(events));

        publishMeetingEvent({ meetingId: "m1", kind: "ended" });

        expect(events).toHaveBeenCalledWith({ meetingId: "m1", kind: "ended" });
        expect(signals).not.toHaveBeenCalled();
    });

    it("caps a payload, and leaves room for a session description a real call sends", () => {
        // Asserted as a constant rather than through the route, because the route
        // is where it is applied and this is the number it applies.
        //
        // The floor is the part that bit: candidates are trickled separately, so
        // the cap was set for an offer that carried them and was well under what
        // a session actually sends. One video m-line is two or three kilobytes of
        // codecs and header extensions, and a call that has renegotiated - a
        // screen shared and stopped, a camera turned on - carries several. Under
        // this, the offer is refused and nobody hears anybody.
        expect(MAX_SIGNAL_BYTES).toBeGreaterThanOrEqual(32 * 1024);
        expect(MAX_SIGNAL_BYTES).toBeLessThanOrEqual(64 * 1024);
    });
});

describe("a signal nobody was listening for", () => {
    it("waits, and is handed over when its recipient arrives", () => {
        // The whole reason a call connects. Nothing is subscribed here, which is
        // exactly the state the second browser's stream is in when the first
        // one's offer is sent.
        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "offer" });

        expect(takeHeldSignals("m1", "b")).toEqual([
            { meetingId: "m1", fromId: "a", toId: "b", payload: "offer" }
        ]);
    });

    it("is taken off the shelf, so a reconnecting browser is not re-offered it", () => {
        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "offer" });
        takeHeldSignals("m1", "b");
        expect(takeHeldSignals("m1", "b")).toEqual([]);
    });

    it("keeps the order it was sent in, since an offer precedes its candidates", () => {
        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "offer" });
        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "candidate" });

        expect(takeHeldSignals("m1", "b").map((signal) => signal.payload)).toEqual([
            "offer",
            "candidate"
        ]);
    });

    it("is not held when somebody did take it", () => {
        stop.push(taking(vi.fn()));
        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "offer" });
        expect(takeHeldSignals("m1", "b")).toEqual([]);
    });

    it("is held when the only listener refused it, which is the lobby", () => {
        // A stream for somebody waiting to be let in answers false. Holding
        // rather than dropping is what lets an offer made while they waited
        // reach them the moment they are admitted.
        stop.push(subscribeSignals(() => false));
        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "offer" });
        expect(takeHeldSignals("m1", "b")).toHaveLength(1);
    });

    it("goes to the participant it names and nobody else", () => {
        publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "offer" });
        expect(takeHeldSignals("m1", "c")).toEqual([]);
        expect(takeHeldSignals("m1", "b")).toHaveLength(1);
    });

    it("is bounded, because this is memory a browser can ask for", () => {
        for (let sent = 0; sent < HOLD_MAX + 20; sent += 1) {
            publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: `n${sent}` });
        }
        const held = takeHeldSignals("m1", "b");
        expect(held).toHaveLength(HOLD_MAX);
        // The newest survive: an old offer is worthless and the recent one is
        // the one the far side is waiting on an answer to.
        expect(held.at(-1)?.payload).toBe(`n${HOLD_MAX + 19}`);
    });
});
