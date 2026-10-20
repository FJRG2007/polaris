// @vitest-environment jsdom
/**
 * Polar's composer grows with what is typed and goes back to its resting height
 * when it is emptied - also when the panel clears it after sending, which no
 * input event announces.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PromptInputTextarea } from "@/components/polar/elements/prompt-input";

vi.mock("@/components/file-picker/use-choose-files", () => ({ useChooseFiles: () => () => {} }));

/** jsdom lays nothing out: a line of text is 20px, two rows at rest. */
function measureByLines() {
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
        configurable: true,
        get(this: HTMLTextAreaElement) {
            return Math.max(2, this.value.split("\n").length) * 20;
        }
    });
}

afterEach(() => {
    cleanup();
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
});

describe("the composer's height", () => {
    it("grows while typing, up to its ceiling", () => {
        measureByLines();
        const { getByRole } = render(
            <PromptInputTextarea value="" onChange={() => {}} onSubmitKey={() => {}} />
        );
        const box = getByRole("textbox") as HTMLTextAreaElement;
        box.value = "one\ntwo\nthree\nfour";
        fireEvent.input(box);
        expect(box.style.height).toBe("80px");
        box.value = Array.from({ length: 30 }, () => "line").join("\n");
        fireEvent.input(box);
        expect(box.style.height).toBe("200px");
    });

    it("is back at rest once the panel clears it after sending", () => {
        measureByLines();
        const long = "one\ntwo\nthree\nfour\nfive\nsix";
        const { getByRole, rerender } = render(
            <PromptInputTextarea value={long} onChange={() => {}} onSubmitKey={() => {}} />
        );
        const box = getByRole("textbox") as HTMLTextAreaElement;
        expect(box.style.height).toBe("120px");
        rerender(<PromptInputTextarea value="" onChange={() => {}} onSubmitKey={() => {}} />);
        expect(box.style.height).toBe("40px");
    });
});
