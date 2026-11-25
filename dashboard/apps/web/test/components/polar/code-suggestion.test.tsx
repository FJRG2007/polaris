// @vitest-environment jsdom

/**
 * The suggested next message in a Code thread: which turn earns one, asked
 * for only for an answer that arrived while the thread was open, shown as the
 * empty box's placeholder, taken with Tab, hidden by typing, and off with the
 * setting.
 */

import { useState } from "react";
import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { PolarCodeEntry, PolarCodeThread } from "@/lib/polar/code";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { codeSuggestionTurn } = await import("@/lib/polar/code-suggestion");
const { useCodeSuggestion } = await import("@/components/polar/code-suggestion");
const { polarDisplayStore } = await import("@/components/polar/polar-display");
const { POLAR_DISPLAY_DEFAULTS } = await import("@/lib/polar/display");

const SESSION = "00000000-0000-4000-8000-000000000001";
const IDLE = { state: "idle" as const, live: true };

const message = (id: string, role: string, text: string): PolarCodeEntry => ({
    id,
    at: "2026-11-25T00:00:00.000Z",
    type: "message",
    role,
    text,
    detail: ""
});

const thread = (entries: PolarCodeEntry[], state: "idle" | "working" = "idle") =>
    ({
        session: { id: SESSION, state, live: true },
        entries,
        permission: null
    }) as unknown as PolarCodeThread;

describe("codeSuggestionTurn", () => {
    const asked = [message("u1", "user", "Fix the build"), message("a1", "agent", "Fixed it.")];

    it("follows the agent's answer once the turn has ended", () => {
        expect(codeSuggestionTurn(asked, IDLE, false)).toEqual({
            answerId: "a1",
            asked: "Fix the build",
            answered: "Fixed it."
        });
    });

    it("is none while the turn runs, while a permission is asked, or after the session ended", () => {
        expect(codeSuggestionTurn(asked, { state: "working", live: true }, false)).toBeNull();
        expect(codeSuggestionTurn(asked, IDLE, true)).toBeNull();
        expect(codeSuggestionTurn(asked, { state: "stopped", live: false }, false)).toBeNull();
    });

    it("is none when the last word is the person's", () => {
        expect(codeSuggestionTurn([...asked, message("u2", "user", "And the tests")], IDLE, false)).toBeNull();
    });
});

let answer: string | null = "Run the tests";
const asks: string[] = [];

beforeEach(() => {
    asks.length = 0;
    answer = "Run the tests";
    polarDisplayStore.set({ ...POLAR_DISPLAY_DEFAULTS });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            // The settings are read too; only the suggestion asks are counted.
            if (!String(url).startsWith("/api/polar/code/suggestion")) {
                return new Response(JSON.stringify({}), { status: 200 });
            }
            asks.push(url);
            return new Response(JSON.stringify({ suggestion: answer }), { status: 200 });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function Box({ current }: { current: PolarCodeThread }) {
    const [value, setValue] = useState("");
    const suggestion = useCodeSuggestion({
        sessionId: SESSION,
        thread: current,
        value,
        onAccept: setValue,
        inputId: "box"
    });
    return (
        <>
            {suggestion.beforeInput}
            <textarea
                id="box"
                aria-label="reply"
                value={value}
                placeholder={suggestion.placeholder("Reply")}
                aria-describedby={suggestion.describedBy}
                onKeyDown={suggestion.onKeyDown()}
                onChange={(event) => setValue(event.target.value)}
            />
        </>
    );
}

const opened = thread([message("u1", "user", "Fix the build"), message("a1", "agent", "Fixed it.")]);
const answered = thread([
    ...opened.entries,
    message("u2", "user", "Now the lint"),
    message("a2", "agent", "Lint is clean.")
]);

function openThenAnswer() {
    const view = render(<Box current={opened} />, { wrapper: MessagesWrapper });
    view.rerender(<Box current={answered} />);
    return view;
}

describe("useCodeSuggestion", () => {
    it("asks nothing for the answer that was there when the thread opened", async () => {
        render(<Box current={opened} />, { wrapper: MessagesWrapper });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(asks).toEqual([]);
        expect(screen.getByLabelText("reply")).toHaveProperty("placeholder", "Reply");
    });

    it("shows a new answer's suggestion in the empty box, asked once", async () => {
        const view = openThenAnswer();
        await waitFor(() => expect(screen.getByLabelText("reply")).toHaveProperty("placeholder", "Run the tests"));
        view.rerender(<Box current={answered} />);
        expect(asks).toHaveLength(1);
        expect(asks[0]).toContain(`sessionId=${SESSION}`);
        expect(asks[0]).toContain("after=a2");
    });

    it("Tab puts it in the box to edit, never sends it", async () => {
        openThenAnswer();
        const box = screen.getByLabelText("reply");
        await waitFor(() => expect(box).toHaveProperty("placeholder", "Run the tests"));
        box.focus();
        await userEvent.keyboard("{Tab}");
        expect(box).toHaveProperty("value", "Run the tests");
        expect(asks).toHaveLength(1);
    });

    it("typing hides it for good", async () => {
        openThenAnswer();
        const box = screen.getByLabelText("reply");
        await waitFor(() => expect(box).toHaveProperty("placeholder", "Run the tests"));
        await userEvent.type(box, "x");
        await userEvent.clear(box);
        expect(box).toHaveProperty("placeholder", "Reply");
    });

    it("asks nothing when switched off", async () => {
        polarDisplayStore.set({ ...POLAR_DISPLAY_DEFAULTS, codeSuggestions: false });
        openThenAnswer();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(asks).toEqual([]);
    });
});
