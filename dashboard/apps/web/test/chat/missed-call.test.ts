/**
 * A call nobody picked up.
 *
 * It used to leave nothing at all: the telephone rang in a tab somebody was not
 * looking at, gave up after half a minute, and that was the end of it. Whoever
 * was called never found out, and whoever called had no way to know their call
 * had even been drawn. Every messenger answers this the same way and Polaris
 * did not.
 *
 * The reasoning is small and has three ways to be subtly wrong, and each of them
 * is a line written into a conversation that should not be there - so it is a
 * pure function, tested here, rather than a condition inside the thing that
 * closes a room.
 */

import { describe, expect, it } from "vitest";
import { whoMissedTheCall } from "@/lib/chat/missed-call";
import { noticeBody, renderNotice } from "@/lib/chat/notice-text";

const ANA = "user-ana";
const BEN = "user-ben";
const CAT = "user-cat";

describe("who missed it", () => {
    it("is everybody who was rung, when nobody answered", () => {
        expect(
            whoMissedTheCall({ hostId: ANA, members: [ANA, BEN, CAT], seated: [ANA] })
        ).toEqual([BEN, CAT]);
    });

    it("is nobody at all once somebody answers", () => {
        // A call three of five people joined is a call. The two who did not are
        // not owed a notice saying nobody picked up.
        expect(
            whoMissedTheCall({ hostId: ANA, members: [ANA, BEN, CAT], seated: [ANA, BEN] })
        ).toEqual([]);
    });

    it("never counts the person who rang", () => {
        // They are in the conversation, and once the room closes they are out of
        // the call like everybody else - which is exactly how a caller ends up
        // being told they missed their own call.
        expect(whoMissedTheCall({ hostId: ANA, members: [ANA, BEN], seated: [ANA] })).toEqual([BEN]);
        expect(whoMissedTheCall({ hostId: ANA, members: [ANA], seated: [ANA] })).toEqual([]);
    });

    it("leaves out somebody who has blocked the caller", () => {
        // Their telephone was deliberately silent, so there was nothing to miss.
        // A notification here would walk straight around the block.
        expect(
            whoMissedTheCall({
                hostId: ANA,
                members: [ANA, BEN, CAT],
                seated: [ANA],
                unreachable: [CAT]
            })
        ).toEqual([BEN]);
    });

    it("counts a guest answering as an answer", () => {
        // Somebody on a guest link has no account, so they are in no seat this
        // can see - and a call they held for ten minutes is not a missed one.
        expect(
            whoMissedTheCall({
                hostId: ANA,
                members: [ANA, BEN],
                seated: [ANA],
                answeredByGuest: true
            })
        ).toEqual([]);
    });

    it("says each person once, whatever the conversation holds", () => {
        expect(
            whoMissedTheCall({ hostId: ANA, members: [ANA, BEN, BEN], seated: [ANA] })
        ).toEqual([BEN]);
    });

    it("says nothing about a call that never rang anybody", () => {
        expect(whoMissedTheCall({ hostId: ANA, members: [], seated: [] })).toEqual([]);
    });
});

describe("the line it leaves in the conversation", () => {
    const body = noticeBody("missedCall", { id: ANA, name: "Ana Ruiz" });

    it("names the caller as a mention, like every other notice", () => {
        expect(body).toBe(`[Ana Ruiz](polaris:user/${ANA}) called - no answer`);
    });

    it("reads correctly to the person who was called", () => {
        expect(renderNotice(body, new Map([[ANA, "Ana Ruiz"]]), BEN)).toBe("Ana Ruiz called - no answer");
    });

    it("reads correctly to the caller themselves", () => {
        // Written from the caller's side for exactly this reason: "missed call
        // from Ana" is nonsense read by Ana.
        expect(renderNotice(body, new Map([[ANA, "Ana Ruiz"]]), ANA)).toBe("You called - no answer");
    });

    it("says nothing about whether it was declined", () => {
        // A refused call and an unanswered one look the same from the other end.
        // Keeping that true is a decision, not an omission.
        expect(body).not.toMatch(/declin|refus|reject/i);
    });
});
