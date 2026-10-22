// @vitest-environment jsdom

/**
 * A dialog never touches the sides of a narrow window. Its width is the window
 * less a margin, capped by its size, so on a phone or in the extension's side
 * panel there is room on each side.
 */

import { Dialog, DialogContent, DialogTitle } from "../src/components/dialog";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

function open(className?: string) {
    render(
        <Dialog open>
            <DialogContent className={className} aria-describedby={undefined}>
                <DialogTitle>Title</DialogTitle>
            </DialogContent>
        </Dialog>
    );
    return screen.getByRole("dialog");
}

describe("a dialog's width", () => {
    it("leaves a margin on each side", () => {
        const classes = open().className.split(/\s+/);
        expect(classes).toContain("w-[calc(100%-2rem)]");
        expect(classes).not.toContain("w-full");
    });

    it("keeps the margin when a dialog only picks its size", () => {
        const classes = open("max-w-md").className.split(/\s+/);
        expect(classes).toContain("w-[calc(100%-2rem)]");
        expect(classes).toContain("max-w-md");
    });
});
