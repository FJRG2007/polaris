/**
 * Code highlighted at build time, so the export ships coloured HTML and no
 * highlighter. Both themes are in the markup as CSS variables; `globals.css`
 * picks the one the page is drawn in.
 */

import { codeToHtml } from "shiki";

export type CodeLanguage = "bash" | "javascript" | "python" | "json" | "powershell";

export interface HighlightedCode {
    readonly label: string;
    readonly code: string;
    readonly html: string;
}

export async function highlight(code: string, lang: CodeLanguage): Promise<string> {
    return codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false
    });
}

/** One line painted for a `<code>` of its own: the spans, without shiki's block. */
export async function highlightInline(code: string, lang: CodeLanguage): Promise<string> {
    const html = await highlight(code, lang);
    return /<code>([\s\S]*)<\/code>/.exec(html)?.[1] ?? "";
}

export async function highlightAll(
    samples: readonly { label: string; code: string; lang: CodeLanguage }[]
): Promise<HighlightedCode[]> {
    return Promise.all(
        samples.map(async (sample) => ({
            label: sample.label,
            code: sample.code,
            html: await highlight(sample.code, sample.lang)
        }))
    );
}
