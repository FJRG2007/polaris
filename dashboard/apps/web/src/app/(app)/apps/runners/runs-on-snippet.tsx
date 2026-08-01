"use client";

/**
 * The line a workflow needs in order to land on this pool.
 *
 * It is the one thing about a runner pool that cannot be worked out by looking at
 * it: everything else on the screen describes what Polaris will do, and this is
 * what the person writing the workflow has to type. Leaving it out means every
 * pool ends with somebody opening the GitHub docs to remember the syntax for a
 * list of labels.
 *
 * Shown wherever a pool is - while it is being created, on its card afterwards,
 * and in the empty state where there is no pool yet - so it is never somewhere
 * else from the thing it describes.
 */

import { Button } from "@polaris/ui";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/** How `runs-on` is written for these labels. One label is a plain scalar, which
 *  is what almost every workflow has; several have to be a list, and getting that
 *  wrong is a workflow that silently waits forever. */
export function runsOnLine(labels: readonly string[]): string {
    if (labels.length === 0) return "runs-on: self-hosted";
    if (labels.length === 1) return `runs-on: ${labels[0]}`;
    return `runs-on: [${labels.join(", ")}]`;
}

export function RunsOnSnippet({ labels, label = "Add this to your workflow:" }: { labels: readonly string[]; label?: string }) {
    const line = runsOnLine(labels);
    const [copied, setCopied] = useState(false);

    // The tick is feedback, not state: it goes back on its own so a card left open
    // does not keep claiming something was just copied.
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(timer);
    }, [copied]);

    async function copy() {
        try {
            await navigator.clipboard.writeText(line);
            setCopied(true);
        } catch {
            // A browser that refuses the clipboard (no permission, insecure origin)
            // still shows the line, which is the part that matters.
        }
    }

    return (
        <div className="flex flex-col gap-1">
            {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{line}</code>
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Copy this line"
                    title="Copy"
                    onClick={() => void copy()}
                >
                    {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                </Button>
            </div>
        </div>
    );
}
