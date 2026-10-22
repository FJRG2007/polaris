// @vitest-environment jsdom

/**
 * A screenshot opened from an app's page is looked through with the arrow keys.
 *
 * The strip of thumbnails pages on the arrow keys too, and the viewer opened
 * from it used to leave focus on the thumbnail: the strip took every arrow, the
 * page behind the viewer scrolled, and the picture in the viewer never changed.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScreenshotGallery } from "@/app/(app)/apps/marketplace/[appId]/screenshot-gallery";

afterEach(cleanup);

const shot = (n: number) => ({
    dark: { desktop: `/fixtures/shot-${n}-dark.webp`, mobile: `/fixtures/shot-${n}-dark-m.webp` },
    light: { desktop: `/fixtures/shot-${n}-light.webp`, mobile: `/fixtures/shot-${n}-light-m.webp` }
});

describe("the opened screenshot and the arrow keys", () => {
    it("moves to the next and previous screenshot from the keyboard", () => {
        render(<ScreenshotGallery name="Calendar" shots={[shot(1), shot(2), shot(3)]} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: "Open Calendar, screenshot 1" }));
        const viewer = screen.getByRole("dialog", { name: "Calendar, screenshot 1" });
        expect(document.activeElement).toBe(viewer);

        fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
        expect(screen.getByRole("dialog", { name: "Calendar, screenshot 2" })).toBeTruthy();

        fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
        expect(screen.getByRole("dialog", { name: "Calendar, screenshot 1" })).toBeTruthy();
    });

    it("gives focus back to the thumbnail it was opened from", () => {
        render(<ScreenshotGallery name="Calendar" shots={[shot(1), shot(2)]} />, {
            wrapper: MessagesWrapper
        });
        const thumbnail = screen.getByRole("button", { name: "Open Calendar, screenshot 1" });
        thumbnail.focus();
        fireEvent.click(thumbnail);
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(thumbnail);
    });
});
