/**
 * Code in a line of text reads as code.
 *
 * The report: `test` in a chat message looked like every other word - as it
 * does not in Discord. The renderer drew it as `<code>`; the shared prose gave
 * it a background the same as the conversation's and the same letters as the
 * words around it. It now gets fixed-width letters and an edge.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "@/components/rich-text/rich-text";

describe("code in a line", () => {
    it("is drawn as code, in fixed-width letters with an edge", () => {
        const html = renderToStaticMarkup(<RichText value="run `npm test` first" />);
        expect(html).toContain("<code>npm test</code>");
        const root = html.slice(0, html.indexOf(">"));
        for (const rule of ["font-mono", "border"])
            expect(root).toContain(`[&amp;_:not(pre)&gt;code]:${rule}`);
    });
});
