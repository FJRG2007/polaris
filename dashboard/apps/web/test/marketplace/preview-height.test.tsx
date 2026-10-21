// @vitest-environment jsdom

/**
 * A store card's preview is a whole number of pixels tall.
 *
 * With a bare 16:10 ratio the preview came out fractional at almost every
 * column width, so the card body and every row under it sat between two
 * pixels and its text stepped up and down against the borders while the page
 * scrolled. The height is rounded against the preview's own width instead.
 */

import { findApp } from "@/lib/apps/catalog";
import { MessagesWrapper } from "../setup/i18n";
import { cleanup, render } from "@testing-library/react";
import { appPreview } from "@/lib/apps/app-screenshots";
import { afterEach, describe, expect, it } from "vitest";
import { AppPreview, PREVIEW_HEIGHT } from "@/app/(app)/apps/marketplace/store-card";

afterEach(cleanup);

const calendar = findApp("calendar")!;

describe("the store card preview", () => {
    it("rounds its height down to a whole pixel of its container's width", () => {
        expect(PREVIEW_HEIGHT).toContain("h-[round(down,calc(100cqw*10/16),1px)]");
        // Kept as the fallback for a browser without round().
        expect(PREVIEW_HEIGHT).toContain("aspect-[16/10]");
    });

    it.each([
        ["a capture", appPreview("calendar", "en-US")],
        ["the placeholder", null]
    ])("measures against its own container with %s", (_, shot) => {
        const { container } = render(<AppPreview app={calendar} shot={shot} />, {
            wrapper: MessagesWrapper
        });
        const box = container.firstElementChild as HTMLElement;
        expect(box.className).toContain("[container-type:inline-size]");
        const frame = box.firstElementChild as HTMLElement;
        for (const token of PREVIEW_HEIGHT.split(" ")) expect(frame.classList).toContain(token);
    });

    it("sizes the container itself when a caller narrows the preview", () => {
        const { container } = render(
            <AppPreview app={calendar} shot={null} className="max-w-2xl rounded-lg" />,
            { wrapper: MessagesWrapper }
        );
        const box = container.firstElementChild as HTMLElement;
        expect(box.classList).toContain("max-w-2xl");
        expect(box.classList).toContain("rounded-lg");
        expect((box.firstElementChild as HTMLElement).classList).not.toContain("max-w-2xl");
    });
});
