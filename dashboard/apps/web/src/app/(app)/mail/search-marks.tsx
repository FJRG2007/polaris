"use client";

/**
 * The words a search asked for, marked wherever a result shows them: the row's
 * subject and line, a collapsed message's preview, and the body of an opened
 * one.
 *
 * Text is marked as text - React renders each run as its own node - and a body
 * is marked on its parsed tree, after the sanitizer, one text node at a time.
 * Neither builds markup out of what a message said, so marking cannot break a
 * message's HTML or let anything in it run.
 */

import { useMemo } from "react";
import * as core from "@polaris/core";
import { useSearchParams } from "next/navigation";

/** The attribute every mark carries, so the pane can find and step through them. */
export const HIT_ATTRIBUTE = "data-search-hit";

/** The words the search in the address asks for, folded; empty when there is
 *  no search. */
export function useSearchNeedles(): readonly string[] {
    const query = useSearchParams().get("q") ?? "";
    return useMemo(
        () => (query.trim() ? core.mailSearchNeedles(core.parseMailSearch(query)) : []),
        [query]
    );
}

/** A line of text with the searched words marked. */
export function Marked({ text, needles }: { text: string; needles: readonly string[] }) {
    if (needles.length === 0) return <>{text}</>;
    return (
        <>
            {core.markMailSearch(text, needles).map((segment, index) =>
                segment.hit ? (
                    <mark
                        key={index}
                        {...{ [HIT_ATTRIBUTE]: "" }}
                        className="rounded-[2px] bg-warning/30 px-px text-inherit"
                    >
                        {segment.text}
                    </mark>
                ) : (
                    <span key={index}>{segment.text}</span>
                )
            )}
        </>
    );
}

/** Elements whose text is not prose a reader sees. */
const SKIPPED = new Set(["STYLE", "SCRIPT", "TITLE", "TEXTAREA", "NOSCRIPT", "MARK"]);

/**
 * Sanitized HTML with the searched words wrapped in `<mark>`.
 *
 * Parsed into an inert template - nothing in it loads or runs - and changed
 * only by splitting text nodes and wrapping the matched part, so every tag and
 * attribute the sanitizer let through is exactly what comes out, and a word in
 * the text is never re-read as markup. The HTML handed in has to be the
 * sanitizer's output already; this adds nothing a sanitizer would remove.
 */
export function markHtml(html: string, needles: readonly string[]): string {
    if (needles.length === 0 || !html || typeof document === "undefined") return html;
    const template = document.createElement("template");
    template.innerHTML = html;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && SKIPPED.has(parent.tagName)) continue;
        texts.push(node as Text);
    }
    let marked = 0;
    for (const node of texts) {
        const value = node.data;
        const hits = core.mailSearchHits(value, needles);
        if (hits.length === 0) continue;
        const pieces = document.createDocumentFragment();
        let at = 0;
        for (const [start, end] of hits) {
            if (start > at) pieces.append(document.createTextNode(value.slice(at, start)));
            const mark = document.createElement("mark");
            mark.setAttribute(HIT_ATTRIBUTE, "");
            mark.textContent = value.slice(start, end);
            pieces.append(mark);
            at = end;
            marked += 1;
        }
        if (at < value.length) pieces.append(document.createTextNode(value.slice(at)));
        node.replaceWith(pieces);
    }
    return marked === 0 ? html : template.innerHTML;
}
