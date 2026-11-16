// @vitest-environment jsdom

/**
 * The translation panel stays open when focus moves away from it.
 *
 * Translating text selected inside a received email opened the panel and
 * closed it in the same instant: the menu that offered "Translate" hands focus
 * back as it closes, focus lands on the email's frame, and the panel read that
 * as a move outside itself. Only a click outside or Escape closes it now.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string) => key
}));
vi.mock("@/components/text-translation/provider", () => ({
    useTextTranslator: () => ({
        preferred: "es",
        translate: async () => ({ kind: "translated", text: "Hola" }),
        choose: () => undefined,
        openHref: () => "/translate"
    })
}));
vi.mock("@/components/text-translation/language-select", () => ({
    LanguageSelect: () => null
}));

import { SelectionTranslation } from "@/components/text-translation/selection-translation";

afterEach(cleanup);

describe("the selection's translation panel", () => {
    it("stays open when focus moves to a frame outside it", async () => {
        const onClose = vi.fn();
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        render(<SelectionTranslation selection={{ x: 10, y: 10, text: "Hello" }} onClose={onClose} />);
        expect(await screen.findByText("Hola")).toBeTruthy();
        act(() => {
            frame.focus();
            frame.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector("[data-selection-translation]")).not.toBeNull();
        frame.remove();
    });

    it("still closes on Escape", async () => {
        const onClose = vi.fn();
        render(<SelectionTranslation selection={{ x: 10, y: 10, text: "Hello" }} onClose={onClose} />);
        await screen.findByText("Hola");
        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(onClose).toHaveBeenCalled();
    });
});
