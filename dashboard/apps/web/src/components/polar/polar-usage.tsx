"use client";

/**
 * What the signed-in person has spent through Polar this month, per model and
 * per key, read from /api/polar/usage when the dialog opens. The cost is the
 * catalogue's estimate (`lib/polar/usage.ts`); a model it has no price for
 * shows its tokens and says the cost is unknown.
 */

import { useEffect, useState } from "react";
import {
    Dialog,
    Skeleton,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogDescription
} from "@polaris/ui";
import type { MonthUsage } from "@/lib/polar/usage";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

export function UsageDialog({ onClose }: { onClose: () => void }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const [usage, setUsage] = useState<MonthUsage | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let live = true;
        fetch("/api/polar/usage")
            .then((response) => (response.ok ? (response.json() as Promise<MonthUsage>) : null))
            .then((data) => {
                if (!live) return;
                if (data) setUsage(data);
                else setFailed(true);
            })
            .catch(() => {
                if (live) setFailed(true);
            });
        return () => {
            live = false;
        };
    }, []);

    const rows = usage?.models ?? [];
    const tokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const cost = rows.reduce((sum, row) => sum + row.costUsd, 0);
    const unpriced = rows.some((row) => row.unpriced > 0);

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="flex max-h-[min(36rem,85dvh)] max-w-lg flex-col gap-3">
                <DialogHeader>
                    <DialogTitle>{t("usage.title")}</DialogTitle>
                    <DialogDescription>
                        {usage
                            ? t("usage.summary", {
                                  tokens: formatTokens(tokens, locale),
                                  cost: formatUsd(cost, locale)
                              })
                            : t("usage.intro")}
                    </DialogDescription>
                </DialogHeader>
                {failed ? (
                    <p role="alert" className="text-sm text-danger-ink">
                        {t("usage.failed")}
                    </p>
                ) : !usage ? (
                    <Skeleton className="h-24 w-full" />
                ) : rows.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        {t("usage.empty")}
                    </p>
                ) : (
                    <ul className="-mx-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
                        {rows.map((row) => (
                            <li
                                key={`${row.provider}/${row.model}/${row.payer}`}
                                className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5"
                            >
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span
                                        className="truncate text-sm text-foreground"
                                        title={row.model}
                                    >
                                        {row.model}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground">
                                        {t(row.payer === "instance" ? "usage.shared" : "usage.own", {
                                            answers: row.answers
                                        })}
                                    </span>
                                </span>
                                <span className="flex shrink-0 flex-col items-end text-xs tabular-nums">
                                    <span className="text-foreground">
                                        {t("usage.tokens", {
                                            input: formatTokens(row.inputTokens, locale),
                                            output: formatTokens(row.outputTokens, locale)
                                        })}
                                    </span>
                                    <span className="text-muted-foreground">
                                        {row.unpriced === row.answers
                                            ? t("usage.noPrice")
                                            : formatUsd(row.costUsd, locale)}
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                {unpriced ? (
                    <p className="text-xs text-muted-foreground">{t("usage.estimate")}</p>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
