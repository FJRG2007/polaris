/**
 * KaTeX and its stylesheet, as one chunk loaded the first time a formula is
 * drawn, so a page with no math never downloads either.
 *
 * `trust: false` is what makes the output safe to set as markup: KaTeX escapes
 * the source and refuses `\href`, `\url`, `\includegraphics` and raw HTML
 * commands. The size and macro-expansion caps stop a formula written to hang
 * the tab from doing so.
 */

import katex from "katex";
import "katex/dist/katex.min.css";

export function renderMath(latex: string, display: boolean): string {
    return katex.renderToString(latex, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxSize: 20,
        maxExpand: 500,
        output: "htmlAndMathml"
    });
}
