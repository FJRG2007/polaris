"use client";

/**
 * Tool: one call Polar made, with its state, and what went in and came back
 * folded under it.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/tool.tsx at ca8be60), Apache-2.0 - see the LICENSE
 * beside this file. Changed: Tailwind 3 and Polaris status tokens instead of
 * fixed colours, a plain disclosure instead of the Radix collapsible, state
 * words from the catalogue, and no code highlighter for the input.
 */

import { cn } from "@polaris/ui";
import { useId, useState, type ReactNode } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CheckCircle2, ChevronDown, Circle, Clock, Wrench, XCircle } from "lucide-react";

export const TOOL_STATES = [
    "input-streaming",
    "input-available",
    "approval-requested",
    "approval-responded",
    "output-available",
    "output-error",
    "output-denied"
] as const;
export type ToolState = (typeof TOOL_STATES)[number];

const ICONS: Record<ToolState, ReactNode> = {
    "input-streaming": <Circle className="h-3.5 w-3.5" />,
    "input-available": <Clock className="h-3.5 w-3.5 motion-safe:animate-pulse" />,
    "approval-requested": <Clock className="h-3.5 w-3.5 text-warning-ink" />,
    "approval-responded": <CheckCircle2 className="h-3.5 w-3.5 text-primary" />,
    "output-available": <CheckCircle2 className="h-3.5 w-3.5 text-success-ink" />,
    "output-error": <XCircle className="h-3.5 w-3.5 text-danger-ink" />,
    "output-denied": <XCircle className="h-3.5 w-3.5 text-warning-ink" />
};

export function Tool({
    title,
    state,
    children,
    className
}: {
    title: string;
    state: ToolState;
    children?: ReactNode;
    className?: string;
}) {
    const t = useTranslations("polar");
    const id = useId();
    const [open, setOpen] = useState(false);
    return (
        <div className={cn("w-full rounded-md border border-border bg-card text-xs", className)}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen(!open)}
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left"
            >
                <Wrench className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={title}>
                    {title}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                    {ICONS[state]}
                    {t(`elements.toolState.${state}`)}
                </span>
                <ChevronDown
                    className={cn("h-3.5 w-3.5 shrink-0 text-foreground-subtle transition-transform duration-fast", open && "rotate-180")}
                />
            </button>
            {open ? (
                <div id={id} className="space-y-2 border-t border-border p-2.5">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

/** Pretty JSON for a value of unknown shape, never throwing. */
export function jsonOf(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? "";
    } catch {
        return String(value);
    }
}

export function ToolInput({ input }: { input: unknown }) {
    const t = useTranslations("polar");
    return (
        <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">{t("elements.parameters")}</p>
            <pre className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                {jsonOf(input)}
            </pre>
        </div>
    );
}

export function ToolOutput({ output, errorText }: { output: unknown; errorText?: string }) {
    const t = useTranslations("polar");
    if (output === undefined && !errorText) return null;
    // Polar's tools answer `{ ok, text }`: the text is what a person reads.
    const text =
        errorText ??
        (output && typeof output === "object" && "text" in output && typeof output.text === "string"
            ? output.text
            : jsonOf(output));
    return (
        <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
                {errorText ? t("elements.error") : t("elements.result")}
            </p>
            <pre
                className={cn(
                    "max-h-56 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded p-2 font-mono text-[11px]",
                    errorText ? "bg-danger-soft text-danger-ink" : "bg-muted text-muted-foreground"
                )}
            >
                {text}
            </pre>
        </div>
    );
}
