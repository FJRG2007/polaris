/**
 * A button marked aria-disabled - a form's Save before it is complete - looks
 * switched off, the same as a disabled one, while it stays focusable and can
 * still say why.
 */

import { describe, expect, it } from "vitest";
import { buttonVariants } from "../src/components/button";

describe("an aria-disabled button", () => {
    it("is drawn switched off by every variant", () => {
        for (const variant of ["primary", "secondary", "outline", "ghost", "danger"] as const) {
            const classes = buttonVariants({ variant }).split(" ");
            expect(classes).toContain("aria-disabled:opacity-50");
            expect(classes).toContain("aria-disabled:cursor-not-allowed");
        }
    });
});
