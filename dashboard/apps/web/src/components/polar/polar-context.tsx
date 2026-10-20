"use client";

/**
 * How full a Polar chat's context is, and the divider a compaction leaves in
 * the conversation. The figures come from `lib/polar/compaction.ts`: the
 * provider's own count of the last turn, the draft estimated, against the
 * model's window when one is known.
 */

import { useEffect, useId, useState } from "react";
import { ChevronDown, Minimize2 } from "lucide-react";
import {
    cn,
    Button,
    Dialog,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogDescription,
    Skeleton
} from "@polaris/ui";
import type { ThreadUsage } from "@/lib/polar/usage";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import { contextFill, type ContextLevel } from "@/lib/polar/compaction";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

const LEVEL_BAR: Record<ContextLevel, string> = {
    ok: "bg-primary",
    warn: "bg-warning",
    over: "bg-danger"
};

/** The line a compaction leaves: earlier messages above stay readable, the
 *  summary that replaced them for the model opens below. */
export function CompactionDivider({ summary, auto }: { summary: string; auto: boolean }) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const panel = useId();
    return (
        <div className="flex flex-col gap-2 py-1">
            <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={panel}
                    onClick={() => setOpen(!open)}
                    className="inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-card-hover hover:text-foreground"
                >
                    <Minimize2 className="size-3.5 shrink-0" />
                    <span className="truncate">
                        {t(auto ? "compact.dividerAuto" : "compact.divider")}
                    </span>
                    <ChevronDown
                        className={cn(
                            "size-3.5 shrink-0 transition-transform",
                            open && "rotate-180"
                        )}
                    />
                </button>
                <span className="h-px flex-1 bg-border" />
            </div>
            {open ? (
                <div
                    id={panel}
                    className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
                >
                    {summary}
                </div>
            ) : null}
        </div>
    );
}

/** What the whole chat has spent so far, from the saved answers. A chat that
 *  was never saved (temporary, or not sent yet) has spent nothing. */
export function ChatSpend({ threadId }: { threadId: string | null }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const [state, setState] = useState<ThreadUsage | "empty" | "failed" | null>(
        threadId ? null : "empty"
    );
    useEffect(() => {
        if (!threadId) return setState("empty");
        let live = true;
        void fetch(`/api/polar/threads/${threadId}/usage`)
            .then(async (response) => {
                if (response.status === 404) return "empty" as const;
                return response.ok ? ((await response.json()) as ThreadUsage) : ("failed" as const);
            })
            .catch(() => "failed" as const)
            .then((next) => (live ? setState(next) : undefined));
        return () => {
            live = false;
        };
    }, [threadId]);
    const usage = typeof state === "object" && state && state.answers > 0 ? state : null;
    return (
        <section className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-foreground">{t("contextUsage.chat")}</h3>
            {state === null ? (
                <Skeleton className="h-5 w-48" />
            ) : state === "failed" ? (
                <p className="text-sm text-muted-foreground">{t("contextUsage.chatFailed")}</p>
            ) : usage ? (
                <p className="text-sm tabular-nums text-muted-foreground" data-polar-chat-spend>
                    {t("contextUsage.chatTotal", {
                        tokens: formatTokens(usage.inputTokens + usage.outputTokens, locale),
                        answers: usage.answers
                    })}
                    {usage.answers > usage.unpriced
                        ? ` - ${t("usage.cost", { cost: formatUsd(usage.costUsd, locale) })}`
                        : null}
                </p>
            ) : (
                <p className="text-sm text-muted-foreground">{t("contextUsage.chatEmpty")}</p>
            )}
        </section>
    );
}

/** How full the context is, as numbers and a bar, with Compact at hand. */
export function ContextDialog({
    used,
    window,
    threadId,
    canCompact,
    onCompact,
    onMonth,
    onClose,
    children
}: {
    used: number;
    window: number | null;
    /** The chat whose spend is shown; null when it is not saved. */
    threadId: string | null;
    canCompact: boolean;
    onCompact: () => void;
    onMonth: () => void;
    onClose: () => void;
    children?: React.ReactNode;
}) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const fill = contextFill(used, window);
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="flex max-w-md flex-col gap-4">
                <DialogHeader>
                    <DialogTitle>{t("contextUsage.title")}</DialogTitle>
                    <DialogDescription>
                        {fill && window
                            ? t("contextUsage.used", {
                                  used: formatTokens(used, locale),
                                  window: formatTokens(window, locale),
                                  share: Math.round(fill.share * 100)
                              })
                            : t("contextUsage.unknown", { used: formatTokens(used, locale) })}
                    </DialogDescription>
                </DialogHeader>
                {fill ? (
                    <div className="flex flex-col gap-1.5">
                        <div
                            role="meter"
                            aria-label={t("contextUsage.title")}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.min(100, Math.round(fill.share * 100))}
                            className="h-2 w-full overflow-hidden rounded-full bg-muted"
                        >
                            <div
                                className={cn("h-full rounded-full", LEVEL_BAR[fill.level])}
                                style={{ width: `${Math.min(100, fill.share * 100)}%` }}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t(`contextUsage.levels.${fill.level}`)}
                        </p>
                    </div>
                ) : null}
                <ChatSpend threadId={threadId} />
                {children}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={onMonth}>
                        {t("contextUsage.month")}
                    </Button>
                    <Button size="sm" disabled={!canCompact} onClick={onCompact}>
                        <Minimize2 />
                        {t("compact.now")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
