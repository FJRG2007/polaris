"use client";

/**
 * A fenced block of code, as it is read.
 *
 * Three backticks and a language is how people already write code in a chat, and
 * until now Polaris drew what came back as grey monospace. This gives it the
 * chrome the rest of the world has taught everybody to expect: the language it
 * declared, a button to take the whole thing, and colour.
 *
 * **The colour arrives late on purpose.** The grammar is a separate chunk, so
 * the block is on screen as plain text on the first paint and repaints once the
 * grammar lands. A message list that waited for a Python grammar before drawing
 * a message would be a message list that waits.
 *
 * **Nothing here trusts the author of the code.** The highlighter escapes the
 * source it is given and only ever adds `span` elements of its own, which is
 * what makes it safe to set as markup - so `<script>` inside a fence is five
 * characters on the screen, the same as it would be anywhere else in Polaris.
 * Unhighlighted code never goes near `innerHTML` at all: it is a text node.
 */

import { cn } from "@polaris/ui";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useHighlighter } from "@/lib/code-highlight";
import { languageForToken } from "@/lib/code-language";

/** How long the copy button stays ticked. Long enough to be seen, short enough
 *  that it is back to itself before anybody reaches for it again. */
const COPIED_MS = 1600;

export function CodeBlock({ code, language }: { code: string; language: string | null }) {
    // Resolved before asking for a grammar, so an unknown fence tag ("output",
    // "text", something misspelled) is never a request for a chunk that does not
    // exist - and the label still shows what was written.
    const known = language ? languageForToken(language) : null;
    const highlighter = useHighlighter(known ? language : null);
    const marked = highlighter && language ? highlighter(code, language) : null;

    return (
        <div
            data-code=""
            className="group/code my-1 overflow-hidden rounded-md border border-border bg-muted"
        >
            <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1">
                <span className="truncate font-mono text-[0.625rem] uppercase tracking-[0.06em] text-foreground-subtle">
                    {known?.label ?? language ?? "code"}
                </span>
                <CopyButton code={code} />
            </div>
            <pre data-code="" className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
                {marked ? (
                    // Highlight.js' own markup: it escaped the source, and the
                    // only elements in it are the spans it added.
                    <code className="hljs" dangerouslySetInnerHTML={{ __html: marked }} />
                ) : (
                    <code>{code}</code>
                )}
            </pre>
        </div>
    );
}

function CopyButton({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    return (
        <button
            type="button"
            title="Copy this code"
            aria-label="Copy this code"
            onClick={async () => {
                if (!navigator.clipboard) return;
                try {
                    await navigator.clipboard.writeText(code);
                    setCopied(true);
                } catch {
                    // Refused on an insecure origin or an unfocused document.
                    // Nothing useful to say about it.
                }
            }}
            className={cn(
                "shrink-0 rounded p-1 transition-colors",
                copied
                    ? "text-success"
                    : "text-muted-foreground hover:bg-card-hover hover:text-foreground"
            )}
        >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
    );
}
