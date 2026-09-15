/**
 * Choosing not to watch what somebody is sharing.
 *
 * A shared screen decides how much of the column the call takes, and on a phone
 * that is the whole window - the panel grows for the picture and the
 * conversation somebody was reading goes with it. Putting the screen away is the
 * way out that is not leaving the call, so it has to take the screen out of the
 * room rather than hide it: everything downstream reads that list to decide
 * whether anything is staged and how tall the panel is worth being.
 *
 * The half that needs pinning down is what happens afterwards. A screen is keyed
 * by whose it is, so the same person sharing again comes back under the key that
 * was put away - and a decision about a share that has ended must not silently
 * hide the next one from the one person who made it.
 */

import { describe, expect, it } from "vitest";
import {
    LOCAL_SCREEN_KEY,
    stillShared,
    watched,
    type CallStage
} from "@/app/(app)/chat/call-media";

/** A share, with only the key mattering here - the stream is what a video
 *  element is pointed at, and nothing in this file points one anywhere. */
function stage(key: string): CallStage {
    return { key, stream: {} as MediaStream, name: key };
}

const mine = stage(LOCAL_SCREEN_KEY);
const theirs = stage("screen:p2");
const third = stage("screen:p3");

describe("what is left to watch", () => {
    it("is everything while nothing has been put away", () => {
        expect(watched([mine, theirs], [])).toEqual([mine, theirs]);
    });

    it("drops the one put away and keeps the rest", () => {
        // The whole point of keying this per screen: two people sharing are two
        // decisions, and putting one away says nothing about the other.
        expect(watched([mine, theirs], [theirs.key])).toEqual([mine]);
    });

    it("can be emptied, which is what gives the conversation its room back", () => {
        expect(watched([mine], [mine.key])).toEqual([]);
    });

    it("ignores a key naming nothing in the room", () => {
        expect(watched([mine], ["screen:somebody-who-left"])).toEqual([mine]);
    });
});

describe("what putting one away is remembered about", () => {
    it("forgets a screen once its share has ended", () => {
        expect(stillShared([theirs.key], [mine])).toEqual([]);
    });

    it("keeps one whose share is still going", () => {
        expect(stillShared([theirs.key], [mine, theirs])).toEqual([theirs.key]);
    });

    it("lets somebody who shares again be watched again", () => {
        // The case this exists for. Put their screen away, they stop sharing,
        // they share again - under the same key, because a key is whose screen
        // it is. Without the forgetting above, the second share is invisible to
        // the one person who chose not to watch the first, and nothing on their
        // screen ever says a share is happening.
        const away = [theirs.key];
        const afterTheyStop = stillShared(away, [mine]);
        expect(watched([mine, theirs], afterTheyStop)).toEqual([mine, theirs]);
    });

    it("holds one decision while a different person starts sharing", () => {
        // The roster changing is not a reason to undo a choice about somebody
        // who is still sharing.
        expect(stillShared([theirs.key], [mine, theirs, third])).toEqual([theirs.key]);
    });

    it("says nothing when nothing was put away", () => {
        expect(stillShared([], [mine, theirs])).toEqual([]);
    });
});
