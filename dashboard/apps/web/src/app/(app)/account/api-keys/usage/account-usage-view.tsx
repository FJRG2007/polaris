"use client";

/**
 * Every key's usage summed, drawn in the browser: the same figures as one
 * key's screen, plus each key's share, a row of which opens that key. The last
 * report seen for a period is kept for the tab, so going back to it shows it at
 * once and refreshes underneath.
 */

import Link from "next/link";
import * as polls from "@/app/(app)/account/account-polls";
import { ArrowLeft, BookOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, cn, SegmentedControl, settingType } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { USAGE_RANGES, type UsageRange } from "@/lib/api-usage/ranges";
import { UsageData, type Load } from "@/app/(app)/account/api-keys/[keyId]/usage/key-usage-view";
import type { AccountUsage } from "@/app/(app)/account/api-keys/usage-actions";

const CACHE_PREFIX = "polaris.api-usage-all.";

function cached(range: UsageRange): AccountUsage | null {
    try {
        const raw = sessionStorage.getItem(`${CACHE_PREFIX}${range}`);
        return raw ? (JSON.parse(raw) as AccountUsage) : null;
    } catch {
        return null;
    }
}

function remember(range: UsageRange, usage: AccountUsage) {
    try {
        sessionStorage.setItem(`${CACHE_PREFIX}${range}`, JSON.stringify(usage));
    } catch {
        // Storage refused (private window, quota): the next visit loads again.
    }
}

export function AccountUsageView() {
    const t = useTranslations("account");
    const [range, setRange] = useState<UsageRange>("7d");
    const [load, setLoad] = useState<Load<AccountUsage>>({ state: "loading" });
    const [attempt, setAttempt] = useState(0);
    const latest = useRef(0);

    useEffect(() => {
        const request = ++latest.current;
        const known = cached(range);
        setLoad(known ? { state: "ready", usage: known } : { state: "loading" });
        polls
            .accountUsage({ range })
            .then((result) => {
                if (request !== latest.current) return;
                if (result.usage) {
                    remember(range, result.usage);
                    setLoad({ state: "ready", usage: result.usage });
                } else if (!known) setLoad({ state: "failed" });
            })
            .catch(() => {
                if (request === latest.current && !known) setLoad({ state: "failed" });
            });
    }, [range, attempt]);

    return (
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        data-swipe-back
                        href="/account/api-keys"
                        className={cn(settingType.small, "inline-flex items-center gap-1 text-muted-foreground no-underline hover:text-foreground")}
                    >
                        <ArrowLeft className="size-3.5 shrink-0" />
                        {t("apiKeys.usage.back")}
                    </Link>
                    <h1 className="truncate text-[1.0625rem] font-semibold tracking-tight">
                        {t("apiKeys.usage.allTitle")}
                    </h1>
                    <p className={cn(settingType.body, "text-muted-foreground")}>{t("apiKeys.usage.allIntro")}</p>
                </div>
                <Button size="sm" variant="outline" asChild>
                    <Link href="/account/api-keys/reference" className="no-underline">
                        <BookOpen className="size-4 shrink-0" />
                        {t("apiKeys.list.reference")}
                    </Link>
                </Button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl
                    aria-label={t("apiKeys.usage.range")}
                    value={range}
                    onValueChange={setRange}
                    options={USAGE_RANGES.map((value) => ({
                        value,
                        label: t(`apiKeys.usage.ranges.${value}` as const)
                    }))}
                />
                <p className={settingType.hint}>{t("apiKeys.usage.kept")}</p>
            </div>

            <UsageData
                load={load}
                onRetry={() => setAttempt((count) => count + 1)}
                labels={load.state === "ready" ? load.usage.labels : undefined}
                emptyHint={t("apiKeys.usage.allEmptyHint")}
                exportName="api-usage-all"
            />
        </div>
    );
}
