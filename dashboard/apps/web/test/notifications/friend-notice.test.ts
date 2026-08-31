/**
 * A notification answered by something other than reading it.
 *
 * "So-and-so added you" says one thing: that a person is now connected to you.
 * Opening a conversation with them says it more directly than the notification
 * does - you are looking at their name, in a thread with them - so a bell still
 * counting it is a bell counting something you demonstrably know.
 *
 * What the matching rests on is the metadata: the row has to say who it is
 * about, and a row that does not, or whose metadata cannot be read, must not be
 * cleared by somebody else's conversation. That is what these pin down, since
 * the column is text holding JSON and everything in it arrived from an older
 * build or from a write that has since changed shape.
 */

import { describe, expect, it } from "vitest";
import { notificationIsAbout } from "@/lib/friends-service";

const ALICE = "0199aaaa-0000-7000-8000-000000000001";
const BOB = "0199bbbb-0000-7000-8000-000000000002";

describe("notificationIsAbout", () => {
    it("matches the person the notification names", () => {
        expect(notificationIsAbout(JSON.stringify({ personId: ALICE }), ALICE)).toBe(true);
    });

    it("does not match anybody else", () => {
        // The one that matters: talking to Bob must not clear the notice about
        // Alice, which is still news you have not seen.
        expect(notificationIsAbout(JSON.stringify({ personId: ALICE }), BOB)).toBe(false);
    });

    it("leaves a row with no metadata alone", () => {
        // Written before the id was recorded. Unknown is not a match.
        expect(notificationIsAbout(null, ALICE)).toBe(false);
        expect(notificationIsAbout("", ALICE)).toBe(false);
    });

    it("leaves a row it cannot read alone rather than throwing", () => {
        expect(notificationIsAbout("{not json", ALICE)).toBe(false);
        expect(notificationIsAbout("null", ALICE)).toBe(false);
        expect(notificationIsAbout('"a string"', ALICE)).toBe(false);
        expect(notificationIsAbout("[]", ALICE)).toBe(false);
    });

    it("does not match on a metadata shape that means something else", () => {
        // A different key holding the same id is a different fact about a
        // different subject.
        expect(notificationIsAbout(JSON.stringify({ actorId: ALICE }), ALICE)).toBe(false);
        expect(notificationIsAbout(JSON.stringify({ personId: null }), ALICE)).toBe(false);
    });
});
