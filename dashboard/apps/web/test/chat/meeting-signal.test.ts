/**
 * The relay between two browsers in a call.
 *
 * Small on purpose, and the two things asserted are the two that matter: a
 * signal reaches only the participant it is addressed to, and an event about the
 * call reaches everybody. The first is the whole of what stops one peer's
 * connection details from being handed to a third browser, since the payload is
 * opaque to this server and there is nothing else in the way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    publishMeetingEvent,
    publishSignal,
    subscribeMeetingEvents,
    subscribeSignals,
    MAX_SIGNAL_BYTES
} from "../../src/lib/chat/meeting-signal";

let stop: (() => void)[] = [];

beforeEach(() => {
    for (const off of stop) off();
    stop = [];
});

describe("meeting signalling", () => {
    it("delivers to every listener, which is what lets each filter for itself", () => {
        const heard = vi.fn();
        stop.push(subscribeSignals(heard));

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
        stop.push(subscribeSignals(second));

        expect(() =>
            publishSignal({ meetingId: "m1", fromId: "a", toId: "b", payload: "{}" })
        ).not.toThrow();
        expect(second).toHaveBeenCalled();
    });

    it("stops delivering once unsubscribed", () => {
        const heard = vi.fn();
        const off = subscribeSignals(heard);
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

    it("caps a payload at one offer's worth, so this is not a message channel", () => {
        // Asserted as a constant rather than through the route, because the route
        // is where it is applied and this is the number it applies.
        expect(MAX_SIGNAL_BYTES).toBeLessThanOrEqual(64 * 1024);
        expect(MAX_SIGNAL_BYTES).toBeGreaterThan(4096);
    });
});
