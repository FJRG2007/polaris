"use client";

/**
 * A highlighted code block with a copy button, and tabs when the same thing
 * is shown in several languages. The HTML was highlighted at build time; this
 * only switches which one is visible.
 */

import { useState } from "react";
import { CopyButton, cn } from "@polaris/ui";
import type { HighlightedCode } from "@/lib/highlight";

export function CodeTabs({ samples, copy }: { samples: readonly HighlightedCode[]; copy: string }) {
    const [index, setIndex] = useState(0);
    const sample = samples[index] ?? samples[0];
    if (!sample) return null;
    return (
        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-1">
                <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                    {samples.map((item, at) => (
                        <button
                            key={item.label}
                            type="button"
                            role="tab"
                            aria-selected={at === index}
                            onClick={() => setIndex(at)}
                            className={cn(
                                "shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground",
                                at === index && "bg-background text-foreground"
                            )}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
                <CopyButton value={sample.code} label={copy} />
            </div>
            <div
                className="code-block overflow-x-auto p-3 text-[13px] leading-relaxed"
                // Highlighted at build time from our own text by Shiki, which escapes it.
                dangerouslySetInnerHTML={{ __html: sample.html }}
            />
        </div>
    );
}
