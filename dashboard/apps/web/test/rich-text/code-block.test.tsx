/**
 * A fenced block of code, as it is read.
 *
 * The one that matters is the last: a code block is the single place in Polaris
 * where the renderer sets HTML rather than building elements, because the
 * highlighter's output *is* markup. So the thing to prove is that markup written
 * by whoever sent the message never becomes markup on the screen - which holds
 * because the unhighlighted path is a text node, and the highlighted one escapes
 * its source before adding spans of its own.
 *
 * Rendered on the server, where no grammar has loaded, which is also the state
 * of the first paint in a browser. Colour arrives afterwards and cannot change
 * what the text is.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "@/components/rich-text/rich-text";

function render(markdown: string): string {
    return renderToStaticMarkup(<RichText value={markdown} />);
}

describe("a fence", () => {
    it("is drawn as a code block", () => {
        const markup = render('```py\nprint("hello")\n```');
        expect(markup).toContain("<pre");
        expect(markup).toContain("<code");
        expect(markup).toContain("hello");
    });

    it("says what language it declared, under the name people know it by", () => {
        // "py" is what somebody types; "Python" is what the header says. A label
        // that echoed the fence tag back would tell the reader nothing they did
        // not just write.
        expect(render("```py\nprint(1)\n```")).toContain("Python");
        expect(render("```ts\nconst a = 1\n```")).toContain("TypeScript");
    });

    it("still draws one when no language was given", () => {
        const markup = render("```\njust some text\n```");
        expect(markup).toContain("just some text");
        expect(markup).toContain("code");
    });

    it("shows an unknown language as it was written rather than guessing", () => {
        expect(render("```wolfram\nx = 1\n```")).toContain("wolfram");
    });

    it("offers to copy what is in it", () => {
        expect(render("```sh\nls -la\n```")).toContain("Copy this code");
    });
});

describe("markup inside a fence", () => {
    it("is text, not markup", () => {
        const markup = render("```html\n<script>alert(1)</script>\n```");
        expect(markup).not.toContain("<script>alert");
        expect(markup).toContain("&lt;script&gt;");
    });

    it("cannot close the block it is in and start an element after it", () => {
        // The shape somebody would actually try: end the code element early and
        // open an image whose error handler runs. It is one text node, so there
        // is nothing to close.
        const markup = render(
            "```js\n</code></pre><img src=x onerror=alert(1)>\n```"
        );
        expect(markup).not.toContain("<img");
        expect(markup).toContain("&lt;img");
    });

    it("carries no attribute out of the language tag", () => {
        // The tag is put on the screen as a label, so a quote in it must not be
        // able to end an attribute.
        const markup = render('```a"onmouseover="alert(1)\nx\n```');
        expect(markup).not.toContain('onmouseover="alert');
    });
});

describe("markdown the editor has no node for", () => {
    it("keeps its source without pretending it is code in a language", () => {
        // A table comes through verbatim. It is not a fence and has no language
        // to declare, so it gets the plain frame rather than a header saying
        // "code".
        const markup = render("| a | b |\n| - | - |\n| 1 | 2 |");
        expect(markup).toContain("<pre>");
        expect(markup).not.toContain("Copy this code");
    });
});
