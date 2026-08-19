/**
 * Where a finished sign-in is allowed to land.
 *
 * The destination arrives in the address bar, which means it is written by
 * whoever sent the link. A sign-in screen that follows one anywhere is an open
 * redirect: the page a person trusts enough to type a password into hands them
 * on to a site somebody else chose, and the address they checked before typing
 * was this one.
 *
 * So the rule is asserted rather than read: a path on this origin, and nothing
 * else. The case that matters most is `//host`, which looks like a path and is
 * read by every browser as a URL on another site.
 */

import { describe, expect, it } from "vitest";
import { safeRedirect } from "@/app/oauth/login/post-login-target";

describe("where a sign-in may send somebody", () => {
    it("keeps a path on this origin", () => {
        expect(safeRedirect("/chat")).toBe("/chat");
        expect(safeRedirect("/tasks?view=board")).toBe("/tasks?view=board");
    });

    it("falls back to the dashboard root when there is nothing to honour", () => {
        expect(safeRedirect(null)).toBe("/");
        expect(safeRedirect(undefined)).toBe("/");
        expect(safeRedirect("")).toBe("/");
    });

    it("refuses another site", () => {
        expect(safeRedirect("https://example.com/steal")).toBe("/");
        expect(safeRedirect("http://example.com")).toBe("/");
    });

    it("refuses a protocol-relative address, which reads as a path and is not one", () => {
        expect(safeRedirect("//example.com")).toBe("/");
        expect(safeRedirect("//example.com/anything")).toBe("/");
    });

    it("refuses anything that is not a path at all", () => {
        expect(safeRedirect("javascript:alert(1)")).toBe("/");
        expect(safeRedirect("chat")).toBe("/");
    });
});
