"use client";

/**
 * Work: everything one answer did before it answered - its thinking and its
 * tool calls - folded into one line above the answer, the way ChatGPT's
 * "Thought for 12s" and Claude's tool-use summary fold theirs. While the turn
 * runs, the line names the current step; once it ends, it says how long the
 * work took and how many tools it used, and opens into the full timeline.
 *
 * Whether a message's timeline is open is remembered for this tab only.
 */

import { cn } from "@polaris/ui";
import { useId, useState, type ReactNode } from "react";
import { ChevronDown, Layers, XCircle } from "lucide-react";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { BusyVerb } from "@/components/polar/elements/busy-verb";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import type { OrbState } from "@/components/polar/motion/orb-engine/presets";
import { useTranslations } from "@/components/i18n/i18n-provider";

const OPEN_KEY = "polar.work.";

function readOpen(messageId: string): boolean {
    try {
        return window.sessionStorage.getItem(OPEN_KEY + messageId) === "1";
    } catch {
        return false;
    }
}

function writeOpen(messageId: string, open: boolean): void {
    try {
        if (open) window.sessionStorage.setItem(OPEN_KEY + messageId, "1");
        else window.sessionStorage.removeItem(OPEN_KEY + messageId);
    } catch {
        // A private window: it simply forgets.
    }
}

export function Work({
    messageId,
    streaming,
    current,
    orb = "solving",
    tools,
    failed,
    seconds,
    summary: said,
    children,
    className
}: {
    messageId: string;
    /** Whether the turn is still running. */
    streaming: boolean;
    /** The step running now, already in words; null while it thinks. */
    current: string | null;
    /** The orb shown beside the line while the turn runs. */
    orb?: OrbState;
    tools: number;
    failed: number;
    /** How long the turn worked, when the server measured it. */
    seconds: number | null;
    /** The folded line in the caller's words, for work that is not tool calls. */
    summary?: string;
    children: ReactNode;
    className?: string;
}) {
    const t = useTranslations("polar");
    const id = useId();
    const [open, setOpen] = useState(() => readOpen(messageId));
    const toggle = () => {
        writeOpen(messageId, !open);
        setOpen(!open);
    };
    const summary =
        said ??
        (seconds !== null
            ? tools > 0
                ? t("work.done", { seconds, tools })
                : t("elements.thoughtFor", { seconds })
            : tools > 0
              ? t("work.used", { tools })
              : t("reasoning"));
    return (
        <div className={cn("w-full text-xs text-muted-foreground", className)}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={toggle}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground"
            >
                {streaming ? (
                    <ThinkingOrb state={orb} size={20} decorative />
                ) : (
                    <Layers className="h-3.5 w-3.5 shrink-0" />
                )}
                {streaming ? (
                    <Shimmer className="min-w-0 truncate">
                        {current ? t("work.running", { step: current }) : <BusyVerb />}
                    </Shimmer>
                ) : (
                    <span className="min-w-0 truncate" title={summary}>
                        {summary}
                    </span>
                )}
                {failed > 0 ? (
                    <span
                        className="inline-flex shrink-0 items-center gap-0.5 text-danger-ink"
                        title={t("work.failed", { count: failed })}
                    >
                        <XCircle className="h-3.5 w-3.5" aria-hidden />
                        <span className="sr-only">{t("work.failed", { count: failed })}</span>
                    </span>
                ) : null}
                <ChevronDown
                    className={cn(
                        "h-3.5 w-3.5 shrink-0 transition-transform duration-fast",
                        open && "rotate-180"
                    )}
                />
            </button>
            {open ? (
                <div id={id} className="mt-1 flex flex-col gap-1.5 border-l border-border pl-3">
                    {children}
                </div>
            ) : null}
        </div>
    );
}
