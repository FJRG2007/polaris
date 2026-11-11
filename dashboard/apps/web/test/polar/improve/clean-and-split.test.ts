/**
 * What a rewrite is cut down to before it replaces a draft, and where an
 * email's own words end and its signature begins - the part the wand never
 * touches.
 */

import { describe, expect, it } from "vitest";
import { cleanImproved } from "@/lib/polar/improve-draft";
import { splitAtSignature } from "@/app/(app)/mail/signature";

describe("cleanImproved", () => {
    it("drops a thinking block, a wrapping fence and wrapping quotes", () => {
        expect(cleanImproved("<think>hm</think>\nFix the bug.")).toBe("Fix the bug.");
        expect(cleanImproved("```\nFix the bug.\n```")).toBe("Fix the bug.");
        expect(cleanImproved("\"Fix the bug.\"")).toBe("Fix the bug.");
    });

    it("keeps quotes inside a longer text, and refuses nothing at all", () => {
        expect(cleanImproved("Say \"hi\" to them.")).toBe("Say \"hi\" to them.");
        expect(cleanImproved("  ")).toBeNull();
    });
});

describe("splitAtSignature", () => {
    it("splits at the delimiter, and the halves join back to the body", () => {
        const body = "Hello Ana,\n\nSee you.\n\n-- \nFran";
        const { head, tail } = splitAtSignature(body);
        expect(head).toBe("Hello Ana,\n\nSee you.\n");
        expect(tail).toBe("\n-- \nFran");
        expect(head + tail).toBe(body);
    });

    it("is the whole body when there is no signature, or it is only in code", () => {
        expect(splitAtSignature("No signature")).toEqual({ head: "No signature", tail: "" });
        const fenced = "Text\n```\n-- \n```";
        expect(splitAtSignature(fenced)).toEqual({ head: fenced, tail: "" });
    });
});
