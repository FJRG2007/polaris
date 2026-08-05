/**
 * The bus behind the live Tasks stream.
 *
 * Two things have to hold for a screen not to lie. A listener that has been
 * dropped must stop hearing anything, or a closed browser connection keeps a
 * subscription alive for the life of the server. And one listener throwing must
 * not stop the others being told, or an open tab that has gone bad silently
 * freezes everybody else's screen - and, worse, turns the successful write that
 * announced it into a failed one.
 */

import { describe, expect, it, vi } from "vitest";
import { publishTaskChange, subscribeTaskChanges, type TaskChange } from "../../src/lib/tasks/live";

const CHANGE: TaskChange = { spaceId: "s1", actorId: "u1" };

describe("the tasks change bus", () => {
    it("tells every listener what changed", () => {
        const heard: TaskChange[] = [];
        const stop = subscribeTaskChanges((change) => heard.push(change));
        const stopToo = subscribeTaskChanges((change) => heard.push(change));

        publishTaskChange(CHANGE);
        stop();
        stopToo();

        expect(heard).toEqual([CHANGE, CHANGE]);
    });

    it("stops telling a listener that unsubscribed", () => {
        const heard: TaskChange[] = [];
        const stop = subscribeTaskChanges((change) => heard.push(change));

        publishTaskChange(CHANGE);
        stop();
        publishTaskChange({ spaceId: "s2", actorId: "u1" });

        expect(heard).toEqual([CHANGE]);
    });

    it("keeps going when one listener throws, and never throws at the writer", () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const heard: TaskChange[] = [];
        const stopBad = subscribeTaskChanges(() => {
            throw new Error("this connection is gone");
        });
        const stopGood = subscribeTaskChanges((change) => heard.push(change));

        expect(() => publishTaskChange(CHANGE)).not.toThrow();
        expect(heard).toEqual([CHANGE]);

        stopBad();
        stopGood();
        errors.mockRestore();
    });

    it("carries a null space for a write that spans them, so nobody is left stale", () => {
        const heard: TaskChange[] = [];
        const stop = subscribeTaskChanges((change) => heard.push(change));

        publishTaskChange({ spaceId: null, actorId: "u1" });
        stop();

        expect(heard[0]?.spaceId).toBeNull();
    });
});
