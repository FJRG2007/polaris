// @vitest-environment jsdom
/**
 * The icon gallery for a device's knob icons: found by a word in either
 * language, drawn in the chosen color at the device's size, and handed over
 * as the setting's value with one press.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useLocale: () => "en",
    useTranslations: () => (key: string) => key
}));

const { findIcons, GALLERY_ICONS, ICON_TINTS, IconGallery } = await import("@/app/(app)/account/plugins/plugin-icons");

afterEach(cleanup);

describe("the knob icon gallery", () => {
    it("finds icons by any of their words, in English or Spanish, and every icon by nothing", () => {
        expect(findIcons("").length).toBe(GALLERY_ICONS.length);
        expect(findIcons("micrófono").map((icon) => icon.name)).toEqual(["mic", "mic-off"]);
        expect(findIcons("GAME").some((icon) => icon.name === "gamepad")).toBe(true);
        expect(findIcons("nothing-like-this")).toEqual([]);
        expect(new Set(GALLERY_ICONS.map((icon) => icon.name)).size).toBe(GALLERY_ICONS.length);
    });

    it("draws the pressed icon at the device's size in the chosen color and hands it over", async () => {
        const draw = vi.fn(async () => "data:image/png;base64,AAAA");
        const onPick = vi.fn();
        const view = render(<IconGallery size={40} onPick={onPick} draw={draw} />);
        fireEvent.click(screen.getByRole("radio", { name: ICON_TINTS[2] }));
        fireEvent.click(view.container.querySelector("[data-icon='headphones']")!);
        await waitFor(() => expect(onPick).toHaveBeenCalledWith("data:image/png;base64,AAAA"));
        expect(draw).toHaveBeenCalledWith(expect.any(SVGElement), 40, ICON_TINTS[2]);
    });

    it("says so when nothing matches", () => {
        render(<IconGallery size={40} onPick={vi.fn()} draw={vi.fn()} />);
        fireEvent.change(screen.getByRole("textbox", { name: "plugins.look.findIcon" }), { target: { value: "zzzz" } });
        expect(screen.getByText("plugins.look.noIcon")).toBeTruthy();
        expect(document.querySelector("[data-icon]")).toBeNull();
    });
});
