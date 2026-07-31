"use client";

/**
 * The rendered Markdown surface: the sanitized HTML, plus the copy affordances
 * that make the code in it usable.
 *
 * A fenced block gets the button GitHub puts there - top right, on hover, and on
 * keyboard focus so it is not mouse-only. Inline code copies on click instead: a
 * button beside a `word` in the middle of a sentence would either reflow the
 * line every time the pointer crossed it or cover the words after it.
 *
 * Both work off the DOM the sanitizer produced. The buttons themselves are React
 * components rendered through a portal into a host node, so nothing from the
 * document is ever turned into an element or a handler.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CopyButton } from "@/components/copy-button";

/** Where a "Copied" acknowledgement is showing, in container coordinates. */
interface Acknowledgement {
    top: number;
    left: number;
}

export function MarkdownContent({ html, className }: { html: string; className?: string }) {
    const container = useRef<HTMLDivElement>(null);
    const [hosts, setHosts] = useState<{ node: HTMLElement; code: string }[]>([]);
    const [copied, setCopied] = useState<Acknowledgement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);

    // One host per fenced block. Re-created whenever the rendered HTML changes,
    // because React replaces the whole subtree and takes the old hosts with it.
    useEffect(() => {
        const root = container.current;
        if (!root) return;
        const created: { node: HTMLElement; code: string }[] = [];
        for (const block of root.querySelectorAll<HTMLElement>(".code-block")) {
            const node = document.createElement("span");
            node.className = "copy-host absolute right-2 top-2 transition-opacity";
            block.append(node);
            created.push({ node, code: block.textContent ?? "" });
        }
        setHosts(created);
        // Effects can run twice for one render; without this, the second pass
        // would leave the first pass's hosts behind as empty spans.
        return () => {
            for (const { node } of created) node.remove();
        };
    }, [html]);

    /**
     * Inline code copies on click. The acknowledgement waits for the write, for
     * the same reason the button's check mark does: a "Copied" over a copy that
     * never happened sends someone off to paste the wrong thing.
     */
    function copyInline(event: React.MouseEvent<HTMLDivElement>) {
        const code = (event.target as HTMLElement).closest<HTMLElement>("code.copy-inline");
        if (!code || !navigator.clipboard) return;
        void navigator.clipboard
            .writeText(code.textContent ?? "")
            .then(() => {
                setCopied({ top: code.offsetTop, left: code.offsetLeft });
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(null), 1500);
            })
            .catch(() => undefined);
    }

    return (
        <div className="relative" ref={container} onClick={copyInline}>
            <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
            {hosts.map(({ node, code }, index) =>
                createPortal(
                    <CopyButton
                        value={code}
                        label="code"
                        className="rounded-md border border-border bg-card p-1.5 hover:bg-card-hover"
                    />,
                    node,
                    String(index)
                )
            )}
            {copied ? (
                <span
                    className="pointer-events-none absolute z-10 -translate-y-6 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                    style={{ top: copied.top, left: copied.left }}
                >
                    Copied
                </span>
            ) : null}
        </div>
    );
}
