/**
 * Which way a draft reopened from Drafts was answering, so the composer can
 * offer the Reply / Reply all / Forward switch on it too.
 */

import { describe, expect, it } from "vitest";
import { draftAnswerKind, replySeed, type AnswerableMessage } from "@/app/(app)/mail/answering";

const me = "me@example.test";
const message: AnswerableMessage = {
    id: "00000000-0000-7000-8000-000000000001",
    accountId: "00000000-0000-7000-8000-000000000002",
    subject: "Plans",
    from: [{ name: "Ana", address: "ana@example.test" }],
    to: [
        { name: "", address: me },
        { name: "Bo", address: "bo@example.test" }
    ],
    cc: [{ name: "Cy", address: "cy@example.test" }],
    replyTo: [],
    listId: "",
    sentAt: "2026-11-20T10:00:00.000Z"
};

describe("draft answer kind", () => {
    it("is a forward when the draft was saved as one", () => {
        expect(draftAnswerKind(message, [me], { to: [], cc: [], forward: true })).toBe("forward");
    });

    it("is a reply to all when it is addressed to everybody Reply all would name", () => {
        const all = replySeed(message, [me], true, "");
        expect(all.to.length + all.cc.length).toBeGreaterThan(1);
        const kind = draftAnswerKind(message, [me], {
            to: all.to.map((one) => ({ ...one, address: one.address.toUpperCase() })),
            cc: all.cc,
            forward: false
        });
        expect(kind).toBe("reply-all");
    });

    it("is a reply when it is addressed to the sender, or to anybody else", () => {
        const single = replySeed(message, [me], false, "");
        expect(draftAnswerKind(message, [me], { to: single.to, cc: [], forward: false })).toBe(
            "reply"
        );
        expect(
            draftAnswerKind(message, [me], {
                to: [...single.to, { name: "", address: "dee@example.test" }],
                cc: [],
                forward: false
            })
        ).toBe("reply");
    });
});
