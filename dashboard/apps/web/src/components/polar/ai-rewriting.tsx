"use client";

/**
 * Wraps a field while "Improve" rewrites what is in it: each line of the text is
 * marked the way a selection marks it, pulsing, with a "Rewriting" chip, and
 * nothing in it can be clicked or typed into until the new text arrives -
 * typing into text about to be replaced is typing that is lost. Around any
 * field: a rich text editor, a textarea, a composer.
 *
 * The marking is a CSS custom highlight over the editor's own text, so it hugs
 * each line to where its words end instead of covering the field in one box. A
 * textarea has no text the page can mark, and a browser without highlights
 * cannot draw one; both get a band of light across the field instead.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function AiRewriting({
    active,
    children,
    className
}: {
    active: boolean;
    children: ReactNode;
    className?: string;
}) {
    const t = useTranslations("components");
    const content = useRef<HTMLDivElement>(null);
    const marked = useLineHighlight(active, content);
    return (
        <div
            className={cn("relative rounded-md", active && "ai-rewriting", className)}
            aria-busy={active || undefined}
        >
            <div
                ref={content}
                data-marked={marked || undefined}
                className={cn(
                    "flex min-h-0 flex-1 flex-col",
                    active && "ai-rewriting-content pointer-events-none select-none"
                )}
            >
                {children}
            </div>
            {active ? (
                <>
                    {marked ? null : <div aria-hidden className="ai-rewriting-veil" />}
                    <span
                        role="status"
                        className="absolute end-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium text-foreground shadow-sm"
                    >
                        <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
                        {t("improve.rewriting")}
                    </span>
                </>
            ) : null}
        </div>
    );
}

/** The registry name, matched by `::highlight(ai-rewriting)` in globals.css. */
const HIGHLIGHT = "ai-rewriting";

/**
 * Marks the text of every editable region inside `root` while `active`, and
 * says whether it could. One highlight for the page: only one field is ever
 * being rewritten at a time.
 */
function useLineHighlight(active: boolean, root: React.RefObject<HTMLDivElement | null>): boolean {
    const [marked, setMarked] = useState(false);
    useEffect(() => {
        const element = root.current;
        if (!active || !element || typeof CSS === "undefined" || !("highlights" in CSS)) return;
        const ranges = [...element.querySelectorAll<HTMLElement>("[contenteditable]")]
            .filter((editable) => editable.textContent?.trim())
            .map((editable) => {
                const range = document.createRange();
                range.selectNodeContents(editable);
                return range;
            });
        if (ranges.length === 0) return;
        CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
        setMarked(true);
        return () => {
            CSS.highlights.delete(HIGHLIGHT);
            setMarked(false);
        };
    }, [active, root]);
    return marked;
}
