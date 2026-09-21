// @vitest-environment jsdom

/**
 * The house rules, when you switch which conversations they are about.
 *
 * One form answers for three kinds of conversation and a picker says which. The
 * fields held their own text from the first render and never took it back from
 * the scope that was chosen after, so switching tab left the previous scope's
 * numbers on screen under the new scope's name - and typing over them edited a
 * draft the reader could not see.
 *
 * What that cost: a limit set to 100 under one tab, read as saved under another,
 * and 25 still in the database. "I have set it and it does not show" is exactly
 * what it looks like from the outside.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRulesView } from "@/app/(app)/admin/chat/chat-rules-view";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { DEFAULT_CHAT_RULES, type ChatRuleScope, type ChatRules } from "@polaris/core";

vi.mock("@/app/(app)/admin/chat/actions", () => ({
    setChatRulesAction: async () => ({})
}));

/** Three scopes that disagree about every number a reader can see. */
const INITIAL: Record<ChatRuleScope, ChatRules> = {
    space: { ...DEFAULT_CHAT_RULES, maxAttachmentMib: 90, maxAttachments: 7 },
    group: { ...DEFAULT_CHAT_RULES, maxAttachmentMib: 25, maxAttachments: 10 },
    dm: { ...DEFAULT_CHAT_RULES, maxAttachmentMib: 5, maxAttachments: 1 }
};

/** The number in the field under a label, as the reader sees it. */
function fieldUnder(label: string): string {
    const heading = screen.getByText(label);
    const input = heading.parentElement?.querySelector("input");
    return (input as HTMLInputElement | null)?.value ?? "";
}

afterEach(cleanup);

describe("switching which conversations the rules are about", () => {
    it("shows that scope's own limits", () => {
        render(<ChatRulesView initial={INITIAL} />);
        expect(fieldUnder("Biggest single file")).toBe("90");

        fireEvent.click(screen.getByText("Group chats"));

        expect(fieldUnder("Biggest single file")).toBe("25");
        expect(fieldUnder("Files on one message")).toBe("10");

        fireEvent.click(screen.getByText("Direct messages"));

        expect(fieldUnder("Biggest single file")).toBe("5");
    });

    it("keeps what was typed under a tab that was left", () => {
        // The drafts live above the fields on purpose: an admin who wants the
        // same limits everywhere types them, saves, switches and saves again.
        render(<ChatRulesView initial={INITIAL} />);
        const input = screen.getByText("Biggest single file").parentElement?.querySelector("input");
        fireEvent.change(input as HTMLInputElement, { target: { value: "64" } });

        fireEvent.click(screen.getByText("Group chats"));
        expect(fieldUnder("Biggest single file")).toBe("25");

        fireEvent.click(screen.getByText("Spaces"));
        expect(fieldUnder("Biggest single file")).toBe("64");
    });
});
