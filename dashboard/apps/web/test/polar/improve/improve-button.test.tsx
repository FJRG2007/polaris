// @vitest-environment jsdom

/**
 * The wand beside a composer's send button: the draft is replaced by the
 * rewrite, Undo puts the draft back until the text is touched again, and a
 * refusal leaves the draft as it was and says why.
 */

import { useState } from "react";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const shown = vi.fn();
vi.mock("@polaris/ui", async (actual) => ({
    ...(await actual<typeof import("@polaris/ui")>()),
    useToast: () => ({ show: shown })
}));

import { ImproveButton } from "@/components/polar/improve-button";

afterEach(() => {
    cleanup();
    shown.mockReset();
    vi.unstubAllGlobals();
});

function Box({ start }: { start: string }) {
    const [value, setValue] = useState(start);
    return (
        <>
            <textarea aria-label="draft" value={value} onChange={(e) => setValue(e.target.value)} />
            <ImproveButton value={value} onChange={setValue} purpose="prompt" />
        </>
    );
}

const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

const draft = () => screen.getByLabelText("draft") as HTMLTextAreaElement;

describe("the improve button", () => {
    it("replaces the draft with the rewrite, and Undo puts it back", async () => {
        const fetch = answer(200, { text: "Write a unit test for the login form." });
        vi.stubGlobal("fetch", fetch);
        render(<Box start="test login" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Improve the prompt" }));
        await waitFor(() => expect(draft().value).toBe("Write a unit test for the login form."));
        expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
            text: "test login",
            purpose: "prompt"
        });
        fireEvent.click(screen.getByRole("button", { name: "Undo the improvement" }));
        expect(draft().value).toBe("test login");
    });

    it("retires Undo once the rewrite is edited", async () => {
        vi.stubGlobal("fetch", answer(200, { text: "Better" }));
        render(<Box start="worse" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Improve the prompt" }));
        await waitFor(() => expect(draft().value).toBe("Better"));
        fireEvent.change(draft(), { target: { value: "Better, edited" } });
        expect(screen.queryByRole("button", { name: "Undo the improvement" })).toBeNull();
        expect(screen.getByRole("button", { name: "Improve the prompt" })).toBeTruthy();
    });

    it("keeps the draft and says why when no model can be used", async () => {
        vi.stubGlobal("fetch", answer(409, { error: "no_model" }));
        render(<Box start="keep me" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Improve the prompt" }));
        await waitFor(() => expect(shown).toHaveBeenCalledWith({ title: "Add an AI key to improve text." }));
        expect(draft().value).toBe("keep me");
    });

    it("asks nothing for an empty draft", () => {
        const fetch = answer(200, { text: "x" });
        vi.stubGlobal("fetch", fetch);
        render(<Box start="   " />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Write something to improve it" }));
        expect(fetch).not.toHaveBeenCalled();
    });
});
