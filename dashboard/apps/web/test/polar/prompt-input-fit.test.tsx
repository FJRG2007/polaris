// @vitest-environment jsdom
/**
 * The composer's box fits its text, but never to a measurement taken while it
 * is not on screen: that left it zero pixels tall - an input nobody could click
 * - once it was shown again.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PromptInputTextarea } from "@/components/polar/elements/prompt-input";

afterEach(cleanup);

describe("the composer's box", () => {
    it("keeps its resting height when it is measured off screen", () => {
        // jsdom lays nothing out, so every box measures as a hidden one does.
        const box = (value: string) => (
            <PromptInputTextarea
                aria-label="Message"
                value={value}
                onChange={() => undefined}
                onSubmitKey={() => undefined}
            />
        );
        const view = render(box(""));
        view.rerender(box("Hello"));
        const field = view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
        expect(field.style.height).not.toBe("0px");
    });
});
