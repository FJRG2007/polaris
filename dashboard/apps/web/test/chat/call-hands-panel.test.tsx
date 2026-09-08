/**
 * The strip that says who has their hand up.
 *
 * It exists because the queue was computed and never drawn: a raised hand was a
 * twelve-pixel icon in a name plate, next to five other twelve-pixel icons, on a
 * face that is a ninth of a window. What is asserted here is what that failed to
 * do - name the person, number the queue, and offer the lowering to the one
 * person entitled to do it for somebody else.
 *
 * The last of those is the one worth a test rather than a look. A hand rides in
 * an attribute only its owner may write, so lowering somebody else's is a
 * request their browser honours - and the check that it came from the chair is
 * on the receiving side, where it belongs. This is the other half: the button is
 * never put in front of somebody whose request would be dropped.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HandStrip } from "@/app/(app)/chat/call-hands-panel";
import type { CallState } from "@/app/(app)/chat/call-state";

const PEOPLE = [
    { id: "seat-ada", name: "Ada" },
    { id: "seat-bo", name: "Bo" },
    { id: "seat-me", name: "Me" }
];

function call(over: { hands?: string[]; hosting?: boolean } = {}): CallState {
    return {
        participantId: "seat-me",
        hands: over.hands ?? [],
        hosting: over.hosting ?? false,
        handRaised: (over.hands ?? []).includes("seat-me"),
        setHandRaised: () => undefined,
        lowerHand: () => undefined,
        meeting: { participants: PEOPLE }
    } as unknown as CallState;
}

const render = (state: CallState): string => renderToStaticMarkup(<HandStrip call={state} />);

/** What somebody actually reads off the strip. Asserted instead of the markup
 *  wherever the question is about order or wording: an icon's `viewBox` carries
 *  a capital B, which is enough to make a search for a name called Bo find the
 *  hand icon and report the queue as being in the wrong order. */
const words = (state: CallState): string => render(state).replace(/<[^>]*>/g, "");

describe("the strip of raised hands", () => {
    it("draws nothing when nobody has asked to speak", () => {
        expect(words(call())).toBe("");
    });

    it("keeps the region that says so mounted while it is empty", () => {
        // A live region and its first content inserted in one commit is a
        // mutation nothing was watching for, and the announcement most screen
        // readers drop is therefore the first hand - the one this exists for.
        const empty = render(call());
        expect(empty).toContain('aria-live="polite"');
        expect(render(call({ hands: ["seat-ada"] }))).toContain('aria-live="polite"');
    });

    it("names the one person who has, rather than counting them", () => {
        const markup = render(call({ hands: ["seat-ada"] }));
        expect(markup).toContain("Ada has their hand up");
        // A queue of one has no order to read, so it is not drawn as one.
        expect(markup).not.toContain("1 in the queue");
    });

    it("numbers the queue once there is an order to it, oldest first", () => {
        const read = words(call({ hands: ["seat-ada", "seat-bo", "seat-me"] }));
        expect(read).toContain("3 hands are up");
        expect(read).toContain("1Ada");
        expect(read).toContain("2Bo");
        expect(read).toContain("3You");
        expect(read.indexOf("Ada")).toBeLessThan(read.indexOf("Bo"));
    });

    it("calls the reader's own hand theirs", () => {
        // Nobody reads their own name in a list of three faster than the word.
        const markup = render(call({ hands: ["seat-ada", "seat-me"] }));
        expect(markup).toContain("You");
        expect(markup).toContain("Lower mine");
    });

    it("offers lowering somebody else's only to whoever is chairing", () => {
        const guest = render(call({ hands: ["seat-ada", "seat-bo"] }));
        expect(guest).not.toContain("Lower all");
        expect(guest).not.toContain("Lower Ada&#x27;s hand");

        const chair = render(call({ hands: ["seat-ada", "seat-bo"], hosting: true }));
        expect(chair).toContain("Lower all");
        expect(chair).toContain("Lower Ada&#x27;s hand");
    });

    it("lets anybody put their own down, chairing or not", () => {
        expect(render(call({ hands: ["seat-me"] }))).toContain("Lower my hand");
    });

    it("says a seat nobody is behind rather than an identifier", () => {
        // Somebody who left between the queue being read and this being drawn.
        expect(render(call({ hands: ["seat-gone"] }))).toContain("Somebody has their hand up");
    });
});
