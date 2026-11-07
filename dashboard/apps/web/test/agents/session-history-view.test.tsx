// @vitest-environment jsdom

/**
 * The conversation on a session's page: prompts typed in Polaris and in the
 * terminal told apart, a tool call folded with its result inside, code fenced
 * in a reply split out to be painted, and older pages loaded upward.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { HistoryMessage } from "@/lib/agents/session-history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const sessionHistory = vi.fn();
vi.mock("../../src/app/(app)/apps/agents/sessions/sessions-polls", () => ({
    sessionHistory: (...args: unknown[]) => sessionHistory(...args)
}));

const { SessionHistory, messageParts } = await import(
    "../../src/app/(app)/apps/agents/sessions/[sessionId]/session-history"
);

beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    sessionHistory.mockReset();
});
afterEach(cleanup);

let n = 0;
function message(overrides: Partial<HistoryMessage>): HistoryMessage {
    n++;
    return {
        id: `0196f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`,
        role: "agent",
        kind: "text",
        subject: "",
        ref: "",
        body: "",
        authorId: null,
        at: new Date(1_700_000_000_000 + n).toISOString(),
        ...overrides
    };
}

describe("SessionHistory", () => {
    it("shows who said what and folds a tool call with its result", () => {
        const messages = [
            message({ role: "user", body: "from the dashboard", authorId: "usr_1" }),
            message({ role: "user", body: "from the terminal" }),
            message({ kind: "tool", subject: "Bash", ref: "toolu_1", body: "npm test" }),
            message({ kind: "result", ref: "toolu_1", body: "12 passed" }),
            message({ role: "system", kind: "marker", subject: "compacted" })
        ];
        render(
            <SessionHistory sessionId="s" initial={{ messages, older: false }} live={false} pending={[]} />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText("from the dashboard")).toBeTruthy();
        expect(screen.getByText("Typed in the terminal")).toBeTruthy();
        expect(screen.getByText("Ran Bash")).toBeTruthy();
        // One fold for the call and its result, not a second row for the result.
        expect(document.querySelectorAll("details")).toHaveLength(1);
        expect(screen.getByText("The conversation was compacted to free up context.")).toBeTruthy();
        expect(screen.queryByText("Load earlier messages")).toBeNull();
    });

    it("loads an older page above, asking for the page before the first one shown", async () => {
        const first = message({ body: "newest page" });
        sessionHistory.mockResolvedValue({ messages: [message({ body: "older page" })], older: false });
        render(
            <SessionHistory sessionId="s" initial={{ messages: [first], older: true }} live={false} pending={[]} />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByText("Load earlier messages"));
        await waitFor(() => expect(screen.getByText("older page")).toBeTruthy());
        expect(sessionHistory).toHaveBeenCalledWith({ sessionId: "s", before: first.id });
        expect(screen.queryByText("Load earlier messages")).toBeNull();
    });

    it("says so when an older page did not load", async () => {
        sessionHistory.mockResolvedValue(null);
        render(
            <SessionHistory sessionId="s" initial={{ messages: [message({ body: "x" })], older: true }} live={false} pending={[]} />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByText("Load earlier messages"));
        await waitFor(() => expect(screen.getByText("Earlier messages did not load. Try again.")).toBeTruthy());
    });
});

describe("messageParts", () => {
    it("splits fenced code out of a reply, with its language when it names one", () => {
        expect(messageParts("Run this:\n```bash\nnpm test\n```\nThen push.")).toEqual([
            { code: false, text: "Run this:\n" },
            { code: true, text: "npm test", language: "bash" },
            { code: false, text: "\nThen push." }
        ]);
        expect(messageParts("```<script>\nx\n```")).toEqual([{ code: true, text: "x", language: null }]);
        // Still being written: an unclosed fence is code to the end.
        expect(messageParts("```ts\nconst a = 1;")).toEqual([{ code: true, text: "const a = 1;", language: "ts" }]);
    });
});
