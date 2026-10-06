/**
 * Which filters the Blocked senders list shows.
 *
 * A block is read off a filter's shape. A filter on several senders, or on one
 * written with its capitals counted, is not one address the list can show and
 * unblock, so it stays a filter.
 */

import type * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import type { MailRuleView } from "@/lib/mailbox/rules";

vi.mock("@/lib/mailbox/rules", () => ({
    saveRule: vi.fn(),
    deleteRule: vi.fn(),
    listRules: vi.fn()
}));

const { blockedBy } = await import("@/lib/mailbox/blocking");

function rule(condition: Partial<core.MailFilterCondition>): MailRuleView {
    return {
        id: "rule-fixture",
        name: "Fixture block",
        enabled: true,
        position: 0,
        matchCount: 0,
        lastRunAt: null,
        definition: {
            triggers: [{ id: "arrival", kind: "arrival" }],
            conditions: {
                match: "all",
                groups: [
                    {
                        id: "group01",
                        match: "all",
                        items: [
                            {
                                id: "cond01",
                                kind: "from",
                                operator: "is",
                                value: "sender@example.com",
                                ...condition
                            }
                        ]
                    }
                ]
            },
            actions: [{ id: "step01", kind: "trash" }]
        } as core.MailFilterDefinition
    };
}

describe("a blocked sender", () => {
    it("is a filter on one sender, matched exactly", () => {
        expect(blockedBy(rule({}))?.address).toBe("sender@example.com");
    });

    it("is not a filter on several senders", () => {
        expect(blockedBy(rule({ alternatives: ["other@example.com"] }))).toBeNull();
    });

    it("is not a filter with its capitals counted", () => {
        expect(blockedBy(rule({ caseSensitive: true }))).toBeNull();
    });
});
