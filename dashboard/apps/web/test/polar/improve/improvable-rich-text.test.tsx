// @vitest-environment jsdom

/**
 * The rich text field with Improve on it, as Tasks uses it: the wand sits by
 * the label, the field shows that it is being rewritten and takes no typing
 * meanwhile, and the rewrite is handed to the field's change and blur both so
 * a description that saves on blur saves it. The fields the rewrite left to
 * fill are listed under it. Without Polar the field is the plain editor.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const allowed = vi.hoisted(() => ({ value: true }));
vi.mock("@/components/polar/polar-allowed", () => ({ usePolarAllowed: () => allowed.value }));
vi.mock("@/app/(app)/mention-actions", () => ({
    resolveReferencesAction: async () => ({}),
    searchMentionsAction: async () => []
}));

const { ImprovableRichText } = await import("@/components/polar/improvable-rich-text");

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    allowed.value = true;
});

describe("a field with Improve", () => {
    it("shows the rewrite under way, then hands the new text to change and blur", async () => {
        let answer: (value: Response) => void = () => undefined;
        const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
        vi.stubGlobal("fetch", fetch);
        const onChange = vi.fn();
        const onBlur = vi.fn();
        render(
            <ImprovableRichText
                label={<h3>Description</h3>}
                purpose="task"
                spaceId="0190a3a0-0000-7000-8000-000000000001"
                value="fix login pls"
                onChange={onChange}
                onBlur={onBlur}
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(screen.getByRole("button", { name: "Improve the text" }));
        expect(await screen.findByText("Rewriting...")).toBeTruthy();
        expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
            purpose: "task",
            text: "fix login pls",
            spaceId: "0190a3a0-0000-7000-8000-000000000001"
        });
        answer(new Response(JSON.stringify({ text: "Fix the login for {{Customer}}." })));
        await waitFor(() => expect(onBlur).toHaveBeenCalledWith("Fix the login for {{Customer}}."));
        expect(onChange).toHaveBeenCalledWith("Fix the login for {{Customer}}.");
        // The status clears in the render after the text is handed over.
        await waitFor(() => expect(screen.queryByText("Rewriting...")).toBeNull());
        expect(screen.getByRole("button", { name: "Customer" })).toBeTruthy();
    });

    it("is the plain editor without Polar", () => {
        allowed.value = false;
        render(<ImprovableRichText purpose="task" value="x" />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("button", { name: "Improve the text" })).toBeNull();
    });

    it("offers no wand on a field that cannot be edited", () => {
        render(<ImprovableRichText purpose="task" value="x" disabled />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("button", { name: "Improve the text" })).toBeNull();
    });
});
