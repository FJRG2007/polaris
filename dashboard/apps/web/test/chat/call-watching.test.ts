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
    putAwayOf,
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

/**
 * What is said about a share nobody is watching.
 *
 * Putting one away took it out of the room completely, which is what gives the
 * conversation its space back - and also what left no trace that it was still
 * happening. A screen somebody was told about a minute ago simply was not there,
 * and the person sharing had no way to know nobody was looking. So the room keeps
 * a line for it, and this is where that line's contents come from.
 */
describe("the shares a reader is told are still going out", () => {
    it("is the one they put away", () => {
        expect(putAwayOf([mine, theirs], [theirs.key])).toEqual([theirs]);
    });

    it("is nothing while they are watching everything", () => {
        expect(putAwayOf([mine, theirs], [])).toEqual([]);
    });

    it("says nothing about a share that has ended", () => {
        // A card is a sentence in the present tense: somebody is sharing, and you
        // are not watching. A key left over from a share that is over would put
        // that sentence on screen about something that is not happening.
        expect(putAwayOf([mine], [theirs.key])).toEqual([]);
    });

    it("accounts for every share exactly once, together with what is watched", () => {
        // The property that matters rather than the arithmetic: a share is either
        // on the stage or behind a card, never both and never neither. Neither is
        // what the defect was - it was in the room, and then it was nowhere.
        const room = [mine, theirs, third];
        const away = [theirs.key];
        const stage = watched(room, away);
        const carded = putAwayOf(room, away);

        expect([...stage, ...carded]).toHaveLength(room.length);
        expect(carded.some((one) => stage.includes(one))).toBe(false);
    });
});
