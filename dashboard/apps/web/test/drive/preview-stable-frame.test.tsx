// @vitest-environment jsdom

/**
 * Stepping between pictures in a Drive preview keeps one frame.
 *
 * Each picture used to open at its own size: the dialog had only a maximum
 * height, the preview was re-keyed per file, so the picture element was thrown
 * away on every step, the frame collapsed to nothing until the next one loaded,
 * and the "open" flight replayed. Now the picture is drawn by the shared image
 * viewer, embedded: the dialog has a fixed height, the stage stays mounted
 * across steps, and the next picture swaps into the same element.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { FileViewer, FilePreview } from "@/app/(app)/drive/file-viewer";

afterEach(cleanup);

const PICTURES = [
    { path: "Album/wide.jpg", name: "wide.jpg", size: "10" },
    { path: "Album/tall.png", name: "tall.png", size: "20" }
];

function viewer(index: number) {
    return withMessages(
        <FileViewer
            target={PICTURES[index]!}
            onOpenChange={() => undefined}
            urlFor={(target) => `/bytes/${target.path}`}
            steps={{ index, count: PICTURES.length, onStep: () => undefined }}
        />
    );
}

describe("a Drive picture preview", () => {
    it("renders through the shared image viewer, embedded", () => {
        render(viewer(0));
        const stage = document.querySelector("[data-image-stage]");
        expect(stage).not.toBeNull();
        // Embedded: no second dialog of its own inside Drive's.
        expect(stage?.closest("[data-image-viewer]")?.getAttribute("role")).toBeNull();
        const picture = document.querySelector<HTMLImageElement>("[data-viewer-picture]");
        expect(picture?.getAttribute("src")).toBe("/bytes/Album/wide.jpg");
    });

    it("keeps the same stage, frame and dialog size while stepping", async () => {
        const { rerender } = render(viewer(0));
        const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
        const stage = document.querySelector("[data-image-stage]");
        const frame = document.querySelector<HTMLElement>("[data-preview-frame]")!;
        const picture = document.querySelector("[data-viewer-picture]");
        const sizes = { dialog: dialog.className, frame: frame.className };
        expect(dialog.className).toContain("h-[90vh]");
        expect(dialog.className).not.toContain("max-h-[90vh]");

        rerender(viewer(1));

        // The same elements, not new ones: nothing collapses, nothing replays.
        expect(document.querySelector("[data-image-stage]")).toBe(stage);
        expect(document.querySelector("[data-preview-frame]")).toBe(frame);
        expect(document.querySelector("[data-viewer-picture]")).toBe(picture);
        expect(document.querySelector<HTMLElement>("[role='dialog']")!.className).toBe(
            sizes.dialog
        );
        expect(frame.className).toBe(sizes.frame);
        // The next picture swaps into the same element once it has decoded.
        await waitFor(() =>
            expect(
                document.querySelector<HTMLImageElement>("[data-viewer-picture]")?.getAttribute(
                    "src"
                )
            ).toBe("/bytes/Album/tall.png")
        );
    });

    it("gives the inline preview a fixed share of the window", () => {
        render(
            withMessages(
                <FilePreview target={PICTURES[0]!} urlFor={(target) => `/bytes/${target.path}`} />
            )
        );
        const frame = document.querySelector<HTMLElement>("[data-preview-frame]")!;
        expect(frame.className).toContain("h-[70vh]");
        expect(frame.querySelector("[data-image-stage]")).not.toBeNull();
    });
});
