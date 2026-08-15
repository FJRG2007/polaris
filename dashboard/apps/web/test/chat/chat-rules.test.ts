/**
 * The house rules: what they default to, what they refuse, and what they mean.
 *
 * The defaults carry most of the weight here. Every one of these limits is a way
 * for an instance to be stricter, and an instance that has never opened the
 * screen must behave exactly as it did before the screen existed - a message can
 * be edited whenever, deleting one leaves a line saying so, and what it said
 * before is readable. A default that drifted would tighten every deployment on
 * upgrade without anybody asking for it.
 *
 * The edit window is checked hardest. Being wrong about it means telling
 * somebody they cannot change something they can.
 */

import { describe, expect, it } from "vitest";
import {
    CHAT_ATTACHMENT_CEILING_MIB,
    CHAT_ATTACHMENT_COUNT_CEILING,
    CHAT_EDIT_WINDOW_CEILING_MINUTES,
    CHAT_NO_LIMIT,
    CHAT_RULE_SCOPES,
    DEFAULT_CHAT_RULES,
    MAX_CHAT_MESSAGE,
    chatRuleScopeOf,
    chatRulesSchema,
    editWindowLabel,
    parseChatRules,
    withinEditWindow
} from "@polaris/core";

describe("what an instance starts on", () => {
    it("lets a message be edited whenever", () => {
        expect(DEFAULT_CHAT_RULES.editWindowMinutes).toBe(CHAT_NO_LIMIT);
        expect(withinEditWindow(DEFAULT_CHAT_RULES, new Date("2020-01-01T00:00:00Z"))).toBe(true);
    });

    it("leaves a line when something is deleted, and keeps what was edited", () => {
        expect(DEFAULT_CHAT_RULES.deleteLeavesTrace).toBe(true);
        expect(DEFAULT_CHAT_RULES.keepEditHistory).toBe(true);
    });

    it("does not rate-limit anybody", () => {
        expect(DEFAULT_CHAT_RULES.maxPerMinute).toBe(CHAT_NO_LIMIT);
    });

    it("allows a message as long as the schema does", () => {
        expect(DEFAULT_CHAT_RULES.maxMessageLength).toBe(MAX_CHAT_MESSAGE);
    });
});

describe("the edit window", () => {
    const rules = { ...DEFAULT_CHAT_RULES, editWindowMinutes: 15 };
    const sent = new Date("2026-08-15T12:00:00Z");

    it("allows an edit inside it", () => {
        expect(withinEditWindow(rules, sent, new Date("2026-08-15T12:14:59Z"))).toBe(true);
    });

    it("allows one exactly on the boundary", () => {
        // A window of fifteen minutes that refuses at fifteen minutes is a
        // window of fourteen, and the refusal would name the wrong number.
        expect(withinEditWindow(rules, sent, new Date("2026-08-15T12:15:00Z"))).toBe(true);
    });

    it("refuses one past it", () => {
        expect(withinEditWindow(rules, sent, new Date("2026-08-15T12:15:01Z"))).toBe(false);
    });

    it("is not fooled by a message dated in the future", () => {
        // Clock skew between the database and the server. Being generous is the
        // safe direction: the alternative refuses an edit to something just sent.
        expect(withinEditWindow(rules, new Date("2026-08-15T12:05:00Z"), sent)).toBe(true);
    });
});

describe("reading rules back", () => {
    it("falls back to the defaults for anything unusable", () => {
        expect(parseChatRules(null)).toEqual(DEFAULT_CHAT_RULES);
        expect(parseChatRules("")).toEqual(DEFAULT_CHAT_RULES);
        expect(parseChatRules("not json")).toEqual(DEFAULT_CHAT_RULES);
        expect(parseChatRules("[1,2,3]")).toEqual(DEFAULT_CHAT_RULES);
    });

    it("fills in a field a stored row is missing", () => {
        // What an upgrade looks like: a row written before a field existed.
        const rules = parseChatRules(JSON.stringify({ maxAttachments: 3 }));
        expect(rules.maxAttachments).toBe(3);
        expect(rules.keepEditHistory).toBe(DEFAULT_CHAT_RULES.keepEditHistory);
    });

    it("takes numbers that arrive as text, which is how a form sends them", () => {
        const rules = parseChatRules(JSON.stringify({ maxPerMinute: "30" }));
        expect(rules.maxPerMinute).toBe(30);
    });
});

describe("what cannot be set", () => {
    it("refuses a message limit past what can be stored", () => {
        expect(chatRulesSchema.safeParse({ maxMessageLength: MAX_CHAT_MESSAGE + 1 }).success).toBe(
            false
        );
        expect(chatRulesSchema.safeParse({ maxMessageLength: 0 }).success).toBe(false);
    });

    it("refuses a file bigger than one request should cost", () => {
        expect(
            chatRulesSchema.safeParse({ maxAttachmentMib: CHAT_ATTACHMENT_CEILING_MIB + 1 }).success
        ).toBe(false);
    });

    it("refuses more files than the ceiling, and a fractional count", () => {
        expect(
            chatRulesSchema.safeParse({ maxAttachments: CHAT_ATTACHMENT_COUNT_CEILING + 1 }).success
        ).toBe(false);
        expect(chatRulesSchema.safeParse({ maxAttachments: 2.5 }).success).toBe(false);
    });

    it("refuses an edit window longer than the ceiling", () => {
        expect(
            chatRulesSchema.safeParse({
                editWindowMinutes: CHAT_EDIT_WINDOW_CEILING_MINUTES + 1
            }).success
        ).toBe(false);
    });

    it("allows zero everywhere zero means no limit", () => {
        const parsed = chatRulesSchema.safeParse({
            maxPerMinute: 0,
            maxAttachments: 0,
            editWindowMinutes: 0
        });
        expect(parsed.success).toBe(true);
    });
});

describe("which rules a conversation is under", () => {
    it("puts a channel under its space", () => {
        expect(chatRuleScopeOf({ spaceId: "space-1", kind: "text" })).toBe("space");
    });

    it("tells a group from a pair", () => {
        expect(chatRuleScopeOf({ spaceId: null, kind: "group" })).toBe("group");
        expect(chatRuleScopeOf({ spaceId: null, kind: "dm" })).toBe("dm");
    });

    it("covers every scope the admin screen offers", () => {
        // The screen edits one set of rules per scope; a scope nothing resolves
        // to would be a form that changes nothing.
        expect([...CHAT_RULE_SCOPES].sort()).toEqual(["dm", "group", "space"]);
    });
});

describe("saying a window in words", () => {
    it("says what zero means rather than printing it", () => {
        expect(editWindowLabel(0)).toBe("always");
    });

    it("uses the unit somebody would use", () => {
        expect(editWindowLabel(1)).toBe("1 minute");
        expect(editWindowLabel(45)).toBe("45 minutes");
        expect(editWindowLabel(60)).toBe("1 hour");
        expect(editWindowLabel(120)).toBe("2 hours");
        expect(editWindowLabel(60 * 24)).toBe("1 day");
        expect(editWindowLabel(60 * 24 * 3)).toBe("3 days");
    });
});
