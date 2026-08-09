/**
 * Where a link stops.
 *
 * Tiptap's own mark declares itself inclusive whenever autolink is on, so the
 * caret resting at the end of a pasted address carries the link into everything
 * typed after it: a space, then a sentence, all pointing at the URL and none of
 * it said so by the person writing. The schema is where that is decided, so the
 * schema is what this asserts - a mark spec that flipped back would take the
 * behaviour with it.
 */

import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { baseExtensions } from "@/components/rich-text/schema";

describe("the link mark", () => {
    const schema = getSchema(baseExtensions("Write something"));

    it("does not extend into what is typed after it", () => {
        expect(schema.marks.link).toBeDefined();
        expect(schema.marks.link?.spec.inclusive).toBe(false);
    });

    it("is still registered once, with the safety attributes on it", () => {
        const mark = schema.marks.link?.create({ href: "https://example.com" });
        expect(mark?.attrs.rel).toBe("noopener noreferrer nofollow");
        expect(mark?.attrs.target).toBe("_blank");
    });
});
