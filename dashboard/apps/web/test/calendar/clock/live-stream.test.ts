/**
 * A timer paused from a Stream Deck reached the deck and never the open Time
 * screen, which kept the old state until it was reloaded. Every clock write in
 * the service now says whose clock moved, and the Time stream tells that
 * account's open tabs - and nobody else's - within a moment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, signIn } from "../fixtures/fake-host";
import * as model from "@polaris-app/calendar/src/lib/clock/model";
import * as clock from "@polaris-app/calendar/src/lib/clock/service";
import { onClockChanged } from "@polaris-app/calendar/src/lib/clock/live";
import { GET as stream } from "@polaris-app/calendar/src/routes/api/calendar/time/stream/route";

const ZONE = "Europe/Madrid";

/** Read frames off an open stream until `count` data frames arrived or the
 *  wait ran out. */
async function frames(response: Response, count: number, waitMs: number): Promise<string[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buffer = "";
    const deadline = Date.now() + waitMs;
    while (seen.length < count && Date.now() < deadline) {
        const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))
        ]);
        if (!chunk || chunk.done) break;
        buffer += decoder.decode(chunk.value);
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) if (part.startsWith("data:")) seen.push(part);
    }
    return seen;
}

describe("the Time screen follows a change made anywhere else", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    const heard: string[] = [];
    let stop: () => void = () => {};

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        heard.length = 0;
        stop = onClockChanged((userId) => heard.push(userId));
    });

    afterEach(() => stop());

    it("announces a timer paused and resumed - what a deck key does - for its owner", async () => {
        const id = await clock.createTimer(alice.id, {
            label: "",
            durationMs: 5 * 60_000,
            sound: "chime",
            start: true
        });
        heard.length = 0;

        await clock.changeTimer(alice.id, id, "pause");
        expect(heard).toEqual([alice.id]);
        await clock.changeTimer(alice.id, id, "start");
        expect(heard).toEqual([alice.id, alice.id]);
    });

    it("announces alarms, the stopwatch and its lanes too, never on a refused write", async () => {
        await clock.saveAlarm(alice.id, null, {
            time: "07:00",
            days: model.EVERY_DAY,
            label: "",
            sound: "chime",
            snoozeMinutes: 10,
            enabled: true
        }, ZONE, world.NOW);
        const alarmId = db.rows("clockAlarm")[0]!.id as string;
        await clock.setAlarmEnabled(alice.id, alarmId, false);
        await clock.changeStopwatch(alice.id, "start");
        const lane = await clock.addLane(alice.id, "Lap");
        await clock.changeLane(alice.id, lane, "start");
        expect(heard).toEqual(Array(5).fill(alice.id));

        await expect(clock.setAlarmEnabled(bob.id, alarmId, true)).rejects.toThrow();
        expect(heard).toHaveLength(5);
    });

    it("wakes the owner's open stream within a second, and only theirs", async () => {
        const id = await clock.createTimer(alice.id, {
            label: "",
            durationMs: 5 * 60_000,
            sound: "chime",
            start: true
        });

        signIn(alice);
        const aborts = [new AbortController(), new AbortController()];
        const own = await stream(new Request("http://x/api/calendar/time/stream", { signal: aborts[0]!.signal }));
        signIn(bob);
        const other = await stream(new Request("http://x/api/calendar/time/stream", { signal: aborts[1]!.signal }));
        expect(own.status).toBe(200);
        expect(own.headers.get("content-type")).toContain("text/event-stream");

        const started = Date.now();
        await clock.changeTimer(alice.id, id, "pause");
        // A burst is one frame.
        await clock.changeTimer(alice.id, id, "start");

        const [ownFrames, otherFrames] = await Promise.all([frames(own, 2, 600), frames(other, 1, 600)]);
        expect(ownFrames).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(otherFrames).toHaveLength(0);
        for (const abort of aborts) abort.abort();
    });

    it("refuses a stream to nobody signed in", async () => {
        signIn(null);
        const response = await stream(new Request("http://x/api/calendar/time/stream"));
        expect(response.status).toBeGreaterThanOrEqual(400);
    });
});
