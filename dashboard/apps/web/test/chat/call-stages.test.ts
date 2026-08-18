/**
 * Which screens get the big place in a call, and in what order.
 *
 * The bug this exists to hold shut: a shared screen used to be folded into the
 * sharer's own camera stream, so the one person in the call who could not see
 * what was being shared was the person sharing it. It arrived in their
 * head-sized tile down in the grid while everybody else had it across the top of
 * theirs - and "make it bigger" did nothing, because as far as the room was
 * concerned there was no screen in it.
 *
 * The other half is that several people can share at once. Each subscriber is
 * only sent what they are watching, so there was never a reason to allow one -
 * and a list that quietly kept the last one would be the same class of bug in
 * the other direction.
 */

import { describe, expect, it } from "vitest";
import { LOCAL_SCREEN_KEY, stagesOf, stagingOf } from "@/app/(app)/chat/call-media";

/** Standing in for a real one: nothing here reads a stream, only carries it. */
const stream = (label: string) => ({ label }) as unknown as MediaStream;

const named = (personId: string) => (personId === "p2" ? "Ada" : "Somebody");

describe("the screens on show", () => {
    it("is empty when nobody is sharing", () => {
        expect(
            stagesOf({
                localScreen: null,
                participantId: "p1",
                screens: new Map(),
                nameOf: named
            })
        ).toEqual([]);
    });

    it("includes your own screen, which is the whole point of it", () => {
        const mine = stream("mine");
        const stages = stagesOf({
            localScreen: mine,
            participantId: "p1",
            screens: new Map(),
            nameOf: named
        });
        expect(stages).toHaveLength(1);
        expect(stages[0]?.stream).toBe(mine);
        expect(stages[0]?.key).toBe(LOCAL_SCREEN_KEY);
    });

    it("puts yours first, so the one you are responsible for is the one you see", () => {
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: "p1",
            screens: new Map([["p2", stream("theirs")]]),
            nameOf: named
        });
        expect(stages.map((stage) => stage.key)).toEqual([LOCAL_SCREEN_KEY, "screen:p2"]);
    });

    it("names somebody else's by whose it is", () => {
        const stages = stagesOf({
            localScreen: null,
            participantId: "p1",
            screens: new Map([["p2", stream("theirs")]]),
            nameOf: named
        });
        expect(stages[0]?.name).toBe("Ada - screen");
    });

    it("keeps every screen when several people share at once", () => {
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: "p1",
            screens: new Map([
                ["p2", stream("two")],
                ["p3", stream("three")],
                ["p4", stream("four")]
            ]),
            nameOf: named
        });
        expect(stages).toHaveLength(4);
    });

    it("draws your own screen once even if it comes back from the server", () => {
        // A client that subscribes to itself would otherwise put two copies of
        // one picture on the stage, the second of them a round trip behind.
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: "p1",
            screens: new Map([["p1", stream("mine, returned")]]),
            nameOf: named
        });
        expect(stages).toHaveLength(1);
        expect(stages[0]?.name).toBe("Your screen");
    });

    it("keeps your screen on the same key when the seat lands", () => {
        // The picture is on screen the moment the browser grants it, which can
        // be before the roster frame naming this browser's seat has arrived. A
        // key built from the seat changes underneath the tile the moment it
        // does: the video element comes down and back up, and the focus
        // somebody had just asked for stops matching anything and is dropped.
        const mine = stream("mine");
        const before = stagesOf({
            localScreen: mine,
            participantId: null,
            screens: new Map(),
            nameOf: named
        });
        const after = stagesOf({
            localScreen: mine,
            participantId: "p1",
            screens: new Map(),
            nameOf: named
        });
        expect(before[0]?.key).toBe(LOCAL_SCREEN_KEY);
        expect(after[0]?.key).toBe(LOCAL_SCREEN_KEY);
    });

    it("still shows somebody else's screen that arrives before your seat does", () => {
        // Nobody is deduplicated against an unknown seat: with no id to compare,
        // a screen from the server is somebody else's.
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: null,
            screens: new Map([["p2", stream("theirs")]]),
            nameOf: named
        });
        expect(stages.map((stage) => stage.key)).toEqual([LOCAL_SCREEN_KEY, "screen:p2"]);
    });

    it("keeps a screen from your own seat when you have none of your own", () => {
        // Dropped instead, a share this browser is not the source of would
        // vanish from the room with nothing put in its place.
        const stages = stagesOf({
            localScreen: null,
            participantId: "p2",
            screens: new Map([["p2", stream("theirs")]]),
            nameOf: named
        });
        expect(stages.map((stage) => stage.key)).toEqual(["screen:p2"]);
    });
});

describe("how the room is laid out around them", () => {
    const stage = (key: string) => ({ key, stream: stream(key), name: key });
    const mine = stage(LOCAL_SCREEN_KEY);
    const theirs = stage("screen:p2");

    it("leaves the faces an even grid when nobody is sharing", () => {
        const staging = stagingOf([], null);
        expect(staging.showing).toEqual([]);
        expect(staging.staged).toBe(false);
        expect(staging.enlarged).toBe(false);
    });

    it("shows every screen at once until somebody asks for one", () => {
        const staging = stagingOf([mine, theirs], null);
        expect(staging.showing).toEqual([mine, theirs]);
        expect(staging.staged).toBe(true);
        // Nothing was asked for, so nothing has been enlarged: the faces stay,
        // as a strip.
        expect(staging.enlarged).toBe(false);
    });

    it("enlarges the only screen there is, which is the ordinary case", () => {
        // The bug: with one share the screen already had the big place and the
        // faces already had the strip, so "make this bigger" drew exactly what
        // was already on screen and the button worked only once a second person
        // shared.
        const staging = stagingOf([mine], LOCAL_SCREEN_KEY);
        expect(staging.showing).toEqual([mine]);
        expect(staging.enlarged).toBe(true);
    });

    it("drops the other screens when one of several is asked for", () => {
        const staging = stagingOf([mine, theirs], theirs.key);
        expect(staging.showing).toEqual([theirs]);
        expect(staging.enlarged).toBe(true);
    });

    it("hides the screens behind a face somebody asked to see bigger", () => {
        // They take the same place, and the panel is still worth its extra
        // height - it is holding a big picture either way.
        const staging = stagingOf([mine, theirs], "camera:p2");
        expect(staging.showing).toEqual([]);
        expect(staging.staged).toBe(true);
        // The faces stay: the strip is how you get back to the other people.
        expect(staging.enlarged).toBe(false);
    });

    it("gives an enlarged face the room a screen would have had", () => {
        // Worked out from the streams instead, this was the case that got none:
        // nobody was sharing, so the panel stayed short while a face filled it.
        expect(stagingOf([], "camera:p2").staged).toBe(true);
    });

    it("leaves the room as it was when the key names nothing", () => {
        // A sharer stopping while somebody was watching them: better an even
        // grid than a panel held tall around an empty rectangle.
        const staging = stagingOf([], "screen:gone");
        expect(staging.showing).toEqual([]);
        expect(staging.staged).toBe(false);
        expect(staging.enlarged).toBe(false);
    });
});
