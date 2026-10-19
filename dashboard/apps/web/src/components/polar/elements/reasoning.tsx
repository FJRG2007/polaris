"use client";

/**
 * Reasoning: the model's thinking, open while it streams and folded away once
 * the answer starts, with how long it took.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/reasoning.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3 and Polaris tokens, a plain
 * button and region instead of the Radix collapsible, words from the catalogue.
 */

import { cn } from "@polaris/ui";
import { Brain, ChevronDown } from "lucide-react";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function Reasoning({
    isStreaming,
    children,
    className
}: {
    isStreaming: boolean;
    children: ReactNode;
    className?: string;
}) {
    const t = useTranslations("polar");
    const id = useId();
    const [open, setOpen] = useState(isStreaming);
    const started = useRef<number | null>(null);
    const [seconds, setSeconds] = useState<number | null>(null);

    useEffect(() => {
        if (isStreaming) {
            started.current ??= Date.now();
            setOpen(true);
            return;
        }
        if (started.current !== null) {
            setSeconds(Math.max(1, Math.round((Date.now() - started.current) / 1000)));
            started.current = null;
            setOpen(false);
        }
    }, [isStreaming]);

    return (
        <div className={cn("w-full text-xs text-muted-foreground", className)}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground"
            >
                <Brain className="h-3.5 w-3.5 shrink-0" />
                {isStreaming ? (
                    <Shimmer>{t("elements.thinking")}</Shimmer>
                ) : seconds !== null ? (
                    <span>{t("elements.thoughtFor", { seconds })}</span>
                ) : (
                    <span>{t("reasoning")}</span>
                )}
                <ChevronDown
                    className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-fast", open && "rotate-180")}
                />
            </button>
            {open ? (
                <div id={id} className="mt-1 whitespace-pre-wrap border-l border-border pl-3">
                    {children}
                </div>
            ) : null}
        </div>
    );
}
