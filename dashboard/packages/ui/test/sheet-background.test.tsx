// @vitest-environment jsdom

/**
 * A side panel is a page of its own, so it is painted with the page background,
 * the same tone Deploy's service panel uses. The `elevated` tone is for what
 * genuinely floats over a page (a menu, a popover, a small dialog); filling a
 * whole-height panel with it reads as a grey slab and was asked out more than once.
 */

import { Dialog, DialogTitle, SheetContent } from "../src/components/dialog";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

describe("a side panel's background", () => {
    it("is the page background, never the floating tone", () => {
        render(
            <Dialog open>
                <SheetContent aria-describedby={undefined}>
                    <DialogTitle>Title</DialogTitle>
                </SheetContent>
            </Dialog>
        );
        const classes = screen.getByRole("dialog").className.split(/\s+/);
        expect(classes).toContain("bg-background");
        expect(classes).not.toContain("bg-elevated");
    });
});
