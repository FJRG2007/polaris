/**
 * A draft settles on its own echo, not only on its send's answer.
 *
 * The live stream brings the stored message to the sender's screen, usually
 * before the send itself has answered. When that answer was slow or never came,
 * the draft sat under the real message as "sending" until the conversation was
 * opened again.
 */

import { describe, expect, it } from "vitest";
import { draftMessage, stillPending } from "@/app/(app)/chat/draft-message";

const draft = (id: string, body: string, authorId = "ada") =>
    draftMessage({ id, channelId: "c1", authorId, authorName: "Ada", body });
const real = (id: string, body: string, authorId = "ada") => ({ ...draft(id, body, authorId) });

describe("which drafts are still waiting", () => {
    it("settles a draft by the id its send answered with", () => {
        const pending = [draft("pending:1", "hello")];
        const sent = new Map([["pending:1", "m1"]]);
        expect(stillPending(pending, [real("m1", "hello")], sent, false)).toEqual([]);
        expect(stillPending(pending, [real("m2", "hello")], sent, false)).toBe(pending);
    });

    it("settles a draft by its echo before the send has answered", () => {
        const pending = [draft("pending:1", "hello ")];
        expect(stillPending(pending, [real("m1", "hello")], new Map(), true)).toEqual([]);
    });

    it("keeps a draft whose echo has not come, or came from somebody else", () => {
        const pending = [draft("pending:1", "hello")];
        expect(stillPending(pending, [real("m1", "hello", "grace")], new Map(), true)).toBe(
            pending
        );
        expect(stillPending(pending, [real("m1", "bye")], new Map(), true)).toBe(pending);
    });

    it("settles two identical lines one echo each", () => {
        const pending = [draft("pending:1", "ok"), draft("pending:2", "ok")];
        const left = stillPending(pending, [real("m1", "ok")], new Map(), true);
        expect(left.map((entry) => entry.id)).toEqual(["pending:2"]);
    });

    it("never takes a message another draft's answer already claimed", () => {
        const pending = [draft("pending:1", "ok"), draft("pending:2", "ok")];
        const sent = new Map([["pending:1", "m1"]]);
        const left = stillPending(pending, [real("m1", "ok")], sent, true);
        expect(left.map((entry) => entry.id)).toEqual(["pending:2"]);
    });

    it("does not read an older line in a reloaded page as the echo", () => {
        const pending = [draft("pending:1", "ok")];
        expect(stillPending(pending, [real("m0", "ok")], new Map(), false)).toBe(pending);
    });
});
