/**
 * How a stored token reads.
 *
 * Drawn as its picture only where the text is handed the set of the space it
 * was written in and the emoji is still in it. Everywhere else - no set at all
 * (a task, a note, a direct message), another space's set, an emoji deleted
 * since, a plain-text excerpt for a notification - it reads as `:name:`, which
 * is what it was typed as. A message that is nothing but a few emoji is drawn
 * large, the way Discord draws it.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "@/components/rich-text/rich-text";
import { plainExcerpt, plainText } from "@/components/rich-text/excerpt";
import { EmojiFace, type CustomEmojiSet } from "@/components/rich-text/custom-emoji";

const WAVE = "0193b0f0-0000-7000-8000-0000000000e1";
const GONE = "0193b0f0-0000-7000-8000-0000000000e4";

const HOME: CustomEmojiSet = {
    from: "Home",
    entries: new Map([
        [WAVE, { id: WAVE, name: "wave", animated: false, src: `/api/chat/emoji/${WAVE}` }]
    ])
};
const OTHER: CustomEmojiSet = { from: "Other", entries: new Map() };

const render = (value: string, set: CustomEmojiSet | null, jumbo = false) =>
    renderToStaticMarkup(<RichText value={value} customEmoji={set} jumboEmoji={jumbo} />);

describe("a space's emoji in a message", () => {
    it("is its picture, named, inside its space", () => {
        const markup = render(`hi <:wave:${WAVE}>`, HOME);
        expect(markup).toContain(`src="/api/chat/emoji/${WAVE}"`);
        expect(markup).toContain('title=":wave:"');
        expect(markup).not.toContain("&lt;:wave:");
    });

    it("is its name with no set, in another space, and once deleted", () => {
        expect(render(`hi <:wave:${WAVE}>`, null)).toContain("hi :wave:");
        expect(render(`hi <:wave:${WAVE}>`, OTHER)).toContain("hi :wave:");
        const gone = render(`hi <:old:${GONE}>`, HOME);
        expect(gone).toContain("hi :old:");
        expect(gone).not.toContain("<img");
    });

    it("is large when the message is nothing else", () => {
        expect(render(`<:wave:${WAVE}> 👍`, HOME, true)).toContain("text-[2.75rem]");
        expect(render(`<:wave:${WAVE}> said hi`, HOME, true)).not.toContain("text-[2.75rem]");
        // Only where the caller asks for it: a quote or a search hit stays small.
        expect(render(`<:wave:${WAVE}>`, HOME, false)).not.toContain("text-[2.75rem]");
    });

    it("never turns markup in a name into markup", () => {
        const markup = render("<:x<img src=y>:nope>", HOME);
        expect(markup).not.toContain("<img src=");
    });
});

describe("a space's emoji outside a message", () => {
    it("is its name in a plain excerpt", () => {
        expect(plainText(`hi <:wave:${WAVE}>`)).toBe("hi :wave:");
        expect(plainExcerpt(`<a:dance:${WAVE}> tonight`)).toBe(":dance: tonight");
    });

    it("is a picture on a reaction chip in its space and the name elsewhere", () => {
        const token = `<:wave:${WAVE}>`;
        expect(renderToStaticMarkup(<EmojiFace value={token} set={HOME} />)).toContain("<img");
        expect(renderToStaticMarkup(<EmojiFace value={token} set={null} />)).toBe(
            "<span>:wave:</span>"
        );
        expect(renderToStaticMarkup(<EmojiFace value="👍" set={HOME} />)).toBe("<span>👍</span>");
    });
});
