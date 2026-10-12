/**
 * Messages changed in place by somebody else, applied to a screen.
 *
 * What is pinned: a deleted message leaves the window, a tombstoned or edited
 * one is swapped where it is, a reply quoting a changed message is read again
 * so its preview follows, and nothing the read did not ask about moves.
 */

import { describe, expect, it } from "vitest";
import type { ChatMessageView } from "../../src/lib/chat/messages";
import { applyChanged, changedTargets } from "../../src/app/(app)/chat/message-changes";

function message(id: string, extra: Partial<ChatMessageView> = {}): ChatMessageView {
    return { id, body: `body ${id}`, deleted: false, quote: null, ...extra } as ChatMessageView;
}

describe("which held messages are read again", () => {
    const held = [
        message("a"),
        message("b"),
        message("c", { quote: { id: "a" } as ChatMessageView["quote"] })
    ];

    it("names the changed message and every message quoting it", () => {
        expect(changedTargets(held, ["a"])).toEqual(["a", "c"]);
    });

    it("names nothing for a message this screen does not hold", () => {
        expect(changedTargets(held, ["elsewhere"])).toEqual([]);
    });

    it("reads everything again when too many changed to name", () => {
        expect(changedTargets(held, [])).toEqual(["a", "b", "c"]);
    });
});

describe("applying what came back", () => {
    const held = [message("a"), message("b"), message("c")];

    it("takes a message deleted without trace off the screen", () => {
        const next = applyChanged(held, ["b"], []);
        expect(next.map((entry) => entry.id)).toEqual(["a", "c"]);
    });

    it("swaps a tombstone or an edit in where the message was", () => {
        const tombstone = message("b", { body: "", deleted: true });
        const edited = message("c", { body: "new words", edited: true });
        const next = applyChanged(held, ["b", "c"], [tombstone, edited]);
        expect(next).toEqual([held[0], tombstone, edited]);
    });

    it("leaves what was not asked about alone, arrivals included", () => {
        const arrived = message("d");
        const next = applyChanged([...held, arrived], ["a"], [message("a", { body: "x" })]);
        expect(next.slice(1)).toEqual([held[1], held[2], arrived]);
    });

    it("hands back the same window when nothing it holds was asked about", () => {
        expect(applyChanged(held, ["z"], [])).toBe(held);
    });
});
