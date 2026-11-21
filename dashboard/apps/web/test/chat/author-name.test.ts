/**
 * A message is named after whoever wrote it wherever it is shown second-hand -
 * a reply's quote, a link to it, a toast, a report - and a message no account
 * wrote is named by the label it was posted under rather than as somebody who
 * has left.
 */

import { describe, expect, it } from "vitest";
import { authorNameOf } from "@/lib/chat/author-name";

const names = new Map([["ada", "Ada"]]);

describe("who wrote a message", () => {
    it("is the person, by their current name", () => {
        expect(authorNameOf({ authorId: "ada" }, names)).toBe("Ada");
    });

    it("is Polar, an app or a webhook by the label it posted under", () => {
        expect(authorNameOf({ authorId: null, agent: "polar", authorLabel: "Polar" }, names)).toBe("Polar");
        expect(authorNameOf({ authorId: null, webhookId: "w1", authorLabel: "CI" }, names)).toBe("CI");
    });

    it("is nobody known for an account that is gone, which the caller words", () => {
        expect(authorNameOf({ authorId: "gone" }, names)).toBeNull();
        expect(authorNameOf({ authorId: null }, names)).toBeNull();
        // A label on a person's message is not theirs to borrow.
        expect(authorNameOf({ authorId: null, authorLabel: "Polar" }, names)).toBeNull();
    });
});
