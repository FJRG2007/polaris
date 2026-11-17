/**
 * The draft of a message being written, as a page and a process apply its
 * frames: grown in order, dropped on a gap, ended by its own id, and matched
 * to the row it becomes.
 */

import { describe, expect, it } from "vitest";
import {
    applyDraftFrame,
    draftFrameSchema,
    draftLanded,
    MAX_DRAFT_CHARS,
    type Draft
} from "@/lib/agents/draft-frames";
import { MAX_TEXT_CHARS } from "@/lib/agents/transcript-decoders";

describe("applyDraftFrame", () => {
    it("grows a draft frame by frame", () => {
        let draft = applyDraftFrame(null, { id: "m1", from: 0, text: "Hel" });
        draft = applyDraftFrame(draft, { id: "m1", from: 3, text: "lo" });
        expect(draft).toEqual({ id: "m1", text: "Hello", ended: false });
    });

    it("overwrites from a repeated offset", () => {
        const draft = applyDraftFrame({ id: "m1", text: "Hello", ended: false }, { id: "m1", from: 3, text: "p!" });
        expect(draft?.text).toBe("Help!");
    });

    it("drops a draft that missed frames rather than draw a hole", () => {
        expect(applyDraftFrame({ id: "m1", text: "Hel", ended: false }, { id: "m1", from: 9, text: "x" })).toBeNull();
        // Joined part way through a message: nothing to show yet.
        expect(applyDraftFrame(null, { id: "m1", from: 4, text: "x" })).toBeNull();
    });

    it("starts a new message in place of the last", () => {
        const draft = applyDraftFrame({ id: "m1", text: "Old", ended: true }, { id: "m2", from: 0, text: "New" });
        expect(draft).toEqual({ id: "m2", text: "New", ended: false });
    });

    it("ends only the draft of its own id", () => {
        const current: Draft = { id: "m1", text: "Hi", ended: false };
        expect(applyDraftFrame(current, { id: "m2", from: 0, text: "", end: true })).toBe(current);
        expect(applyDraftFrame(current, { id: "m1", from: 0, text: "", end: true })).toEqual({ ...current, ended: true });
        expect(applyDraftFrame(null, { id: "m1", from: 0, text: "", end: true })).toBeNull();
    });

    it("keeps a draft inside the stored row's bound", () => {
        expect(MAX_DRAFT_CHARS).toBe(MAX_TEXT_CHARS);
        const big = "x".repeat(MAX_DRAFT_CHARS);
        const draft = applyDraftFrame({ id: "m1", text: big, ended: false }, { id: "m1", from: big.length, text: "more" });
        expect(draft?.text.length).toBe(MAX_DRAFT_CHARS);
    });
});

describe("draftFrameSchema", () => {
    it("refuses a frame outside its bounds", () => {
        expect(draftFrameSchema.safeParse({ id: "", from: 0, text: "" }).success).toBe(false);
        expect(draftFrameSchema.safeParse({ id: "m", from: -1, text: "" }).success).toBe(false);
        expect(draftFrameSchema.safeParse({ id: "m", from: 0, text: "x".repeat(MAX_DRAFT_CHARS + 1) }).success).toBe(false);
        expect(draftFrameSchema.safeParse({ id: "m", from: 0, text: "", end: false }).success).toBe(false);
        expect(draftFrameSchema.safeParse({ id: "m", from: 0, text: "", end: true }).success).toBe(true);
    });
});

describe("draftLanded", () => {
    const draft: Draft = { id: "m1", text: "  Looking at the tests", ended: true };

    it("finds the row the draft became among the newest messages", () => {
        expect(draftLanded(draft, ["Earlier.", "Looking at the tests.\n\nAll green."])).toBe(true);
    });

    it("does not take an older or different message for it", () => {
        expect(draftLanded(draft, ["Something else."])).toBe(false);
        expect(draftLanded(draft, ["Looking at the tests.", "a", "b", "c"])).toBe(false);
    });
});
