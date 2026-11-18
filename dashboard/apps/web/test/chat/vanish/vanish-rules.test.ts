import { describe, expect, it } from "vitest";
import * as rules from "@/lib/chat/vanish-rules";
import * as history from "@/lib/chat/history-visibility";

describe("expiry assignment", () => {
    const sent = new Date("2026-11-16T10:00:00.000Z");

    it("counts from the moment the message is sent", () => {
        expect(rules.expiryFor(sent, 86_400)?.toISOString()).toBe("2026-11-17T10:00:00.000Z");
        expect(rules.expiryFor(sent, 7_776_000)?.toISOString()).toBe("2027-02-14T10:00:00.000Z");
    });

    it("gives no expiry when the timer is off or not one of the offered ones", () => {
        expect(rules.expiryFor(sent, 0)).toBeNull();
        expect(rules.expiryFor(sent, 3600)).toBeNull();
    });

    it("reads a message as expired from its expiry on", () => {
        const at = new Date("2026-11-16T10:00:00.000Z");
        expect(rules.isExpired(at, at.getTime() - 1)).toBe(false);
        expect(rules.isExpired(at, at.getTime())).toBe(true);
        expect(rules.isExpired(null, Date.now())).toBe(false);
    });
});

describe("the rules in force", () => {
    const stored = { vanishAfter: 604_800, deleteForAll: false, rulesAgreedAt: null };

    it("open: the stored timer, and delete for both always allowed", () => {
        expect(rules.effectiveRules("open", stored)).toEqual({
            vanishAfter: 604_800,
            deleteForAll: true,
            receipts: "follow",
            typing: "follow"
        });
    });

    it("agreement without an agreement: no timer and no delete for both", () => {
        expect(rules.effectiveRules("agreement", stored)).toEqual({
            vanishAfter: 0,
            deleteForAll: false,
            receipts: "follow",
            typing: "follow"
        });
    });

    it("agreement with one: exactly what was agreed", () => {
        const agreed = { ...stored, deleteForAll: true, rulesAgreedAt: new Date() };
        expect(rules.effectiveRules("agreement", agreed)).toEqual({
            vanishAfter: 604_800,
            deleteForAll: true,
            receipts: "follow",
            typing: "follow"
        });
    });

    it("only direct conversations outside a space have these rules", () => {
        expect(rules.hasDirectRules({ kind: "dm", spaceId: null })).toBe(true);
        expect(rules.hasDirectRules({ kind: "group", spaceId: null })).toBe(true);
        expect(rules.hasDirectRules({ kind: "text", spaceId: "s" })).toBe(false);
        expect(rules.hasDirectRules({ kind: "group", spaceId: "s" })).toBe(false);
    });
});

describe("proposals", () => {
    const members = ["a", "b", "c"];
    const pending = { status: "pending", acceptedBy: ["a"] };

    it("the one who proposed cannot answer their own; another member can", () => {
        expect(rules.mayAnswerProposal(pending, "a", members)).toBe(false);
        expect(rules.mayAnswerProposal(pending, "b", members)).toBe(true);
    });

    it("somebody outside the chat cannot answer", () => {
        expect(rules.mayAnswerProposal(pending, "z", members)).toBe(false);
    });

    it("a settled proposal cannot be answered", () => {
        expect(rules.mayAnswerProposal({ ...pending, status: "declined" }, "b", members)).toBe(false);
    });

    it("is accepted only once every member has accepted", () => {
        expect(rules.proposalAccepted(["a", "b"], members)).toBe(false);
        expect(rules.proposalAccepted(["a", "b", "c"], members)).toBe(true);
        expect(rules.proposalAccepted(["A", "B"], ["a", "b"])).toBe(true);
    });
});

describe("readers never return expired, hidden or cleared messages", () => {
    it("every single-conversation read filters expiry and the reader's hidden marks", () => {
        const clause = JSON.stringify(history.sinceClause(null, "reader"));
        expect(clause).toContain("expiresAt");
        expect(clause).toContain('"hiddenFor":{"none":{"userId":"reader"}}');
    });

    it("a cleared chat is a floor like any other", () => {
        const floor = new Date("2026-11-16T00:00:00.000Z");
        const clause = JSON.stringify(history.sinceClause(floor, "reader"));
        expect(clause).toContain('"createdAt":{"gte":"2026-11-16T00:00:00.000Z"}');
    });

    it("reads across conversations filter expiry even with no floors", () => {
        const clause = JSON.stringify(history.readableWhere(new Map(), "reader"));
        expect(clause).toContain("expiresAt");
        expect(clause).toContain("hiddenFor");
    });

    it("one message past its expiry is not readable", () => {
        const past = new Date(Date.now() - 1000);
        expect(history.isReadable(null, new Date(0), past)).toBe(false);
        expect(history.isReadable(null, new Date(0), new Date(Date.now() + 60_000))).toBe(true);
    });
});
