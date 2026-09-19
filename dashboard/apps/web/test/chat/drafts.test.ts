/**
 * The message somebody was halfway through writing.
 *
 * Three rules do the work, and each of them is a way to get it wrong. Blank
 * means gone, because a draft that survived somebody clearing the box would put
 * back words they had deliberately taken out - and whitespace, or a run of hard
 * breaks, is blank however many characters it is. Sending throws it away,
 * because it is somewhere that is not a browser now. And what comes back out of
 * storage is untrusted like anything else: local storage belongs to whoever owns
 * the browser, and a shape that does not fit must not reach the box somebody
 * types in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    }
});

const {
    channelDraftKey,
    dropDraft,
    keepDraft,
    readDraft,
    removeSavedDraft,
    saveDraft,
    savedDrafts,
    threadDraftKey
} = await import("../../src/app/(app)/chat/drafts");

const KEY = channelDraftKey("general");

beforeEach(() => store.clear());

describe("keeping what was typed", () => {
    it("gives it back under the same conversation", () => {
        keepDraft(KEY, "the difficult reply");
        expect(readDraft(KEY)).toBe("the difficult reply");
    });

    it("keeps a thread apart from the channel it hangs off", () => {
        keepDraft(KEY, "in the channel");
        keepDraft(threadDraftKey("msg-1"), "in the thread");
        expect(readDraft(KEY)).toBe("in the channel");
        expect(readDraft(threadDraftKey("msg-1"))).toBe("in the thread");
    });

    it("has nothing for a conversation nobody has typed in", () => {
        expect(readDraft(channelDraftKey("elsewhere"))).toBe("");
    });
});

describe("emptying the box", () => {
    it("throws the draft away", () => {
        keepDraft(KEY, "second thoughts");
        keepDraft(KEY, "");
        expect(readDraft(KEY)).toBe("");
    });

    it("counts whitespace as empty, because whitespace is not a message", () => {
        keepDraft(KEY, "second thoughts");
        keepDraft(KEY, "   ");
        expect(readDraft(KEY)).toBe("");
    });

    it("counts a run of hard breaks as empty too", () => {
        keepDraft(KEY, "second thoughts");
        keepDraft(KEY, "\\\n\\\n");
        expect(readDraft(KEY)).toBe("");
    });

    it("leaves the storage key behind for nobody once the last one goes", () => {
        keepDraft(KEY, "something");
        keepDraft(KEY, "");
        expect(store.size).toBe(0);
    });
});

describe("sending it", () => {
    it("takes the draft with it", () => {
        keepDraft(KEY, "on its way");
        dropDraft(KEY);
        expect(readDraft(KEY)).toBe("");
    });

    it("leaves every other conversation alone", () => {
        keepDraft(KEY, "here");
        keepDraft(channelDraftKey("other"), "there");
        dropDraft(KEY);
        expect(readDraft(channelDraftKey("other"))).toBe("there");
    });
});

describe("what comes back out of storage", () => {
    it("is ignored when it is not the shape this wrote", () => {
        store.set("polaris.chat.drafts", JSON.stringify({ [KEY]: { body: 42, at: "yesterday" } }));
        expect(readDraft(KEY)).toBe("");
    });

    it("is ignored when it is not JSON at all", () => {
        store.set("polaris.chat.drafts", "{{{");
        expect(readDraft(KEY)).toBe("");
    });

    it("is ignored when it is a list rather than a bag of drafts", () => {
        store.set("polaris.chat.drafts", JSON.stringify(["nope"]));
        expect(readDraft(KEY)).toBe("");
    });

    it("drops one that has been sitting there for months", () => {
        const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
        store.set("polaris.chat.drafts", JSON.stringify({ [KEY]: { body: "last winter", at: old } }));
        // Read back as it stands - and gone the next time anything is written,
        // which is where the window is applied.
        expect(readDraft(KEY)).toBe("last winter");
        keepDraft(channelDraftKey("other"), "today");
        expect(readDraft(KEY)).toBe("");
    });
});

describe("putting a draft aside", () => {
    it("keeps it beside the box's own draft rather than in place of it", () => {
        keepDraft(KEY, "what is in the box");
        saveDraft(KEY, "what was put aside");
        expect(readDraft(KEY)).toBe("what is in the box");
        expect(savedDrafts(KEY).map((draft) => draft.body)).toEqual(["what was put aside"]);
    });

    it("lists them newest first, and only under their own conversation", () => {
        const now = Date.now();
        saveDraft(KEY, "older", now - 2000);
        saveDraft(KEY, "newer", now - 1000);
        saveDraft(channelDraftKey("elsewhere"), "not here", now);
        expect(savedDrafts(KEY).map((draft) => draft.body)).toEqual(["newer", "older"]);
    });

    it("keeps two saved in the same moment as two", () => {
        const now = Date.now();
        saveDraft(KEY, "one", now);
        saveDraft(KEY, "two", now);
        expect(savedDrafts(KEY)).toHaveLength(2);
    });

    it("keeps nothing that is only whitespace", () => {
        expect(saveDraft(KEY, "   ")).toBeNull();
        expect(savedDrafts(KEY)).toEqual([]);
    });

    it("forgets one that is brought back or thrown away, and only that one", () => {
        const now = Date.now();
        const first = saveDraft(KEY, "first", now - 1)!;
        saveDraft(KEY, "second", now);
        removeSavedDraft(first);
        expect(savedDrafts(KEY).map((draft) => draft.body)).toEqual(["second"]);
    });

    it("does not mistake a thread's drafts for its channel's", () => {
        saveDraft(threadDraftKey("m1"), "in the thread");
        expect(savedDrafts(KEY)).toEqual([]);
        expect(savedDrafts(threadDraftKey("m1"))).toHaveLength(1);
    });
});
