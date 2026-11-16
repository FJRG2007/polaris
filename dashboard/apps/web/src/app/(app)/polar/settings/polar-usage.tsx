"use client";

/**
 * The Usage page of Polar's settings: what each key spent this month, where
 * the calls came from, and the recent fallbacks.
 *
 * A key row carries its provider's logo. Calls recorded without the key that
 * paid (from before keys were itemized) are named by who paid - your keys or
 * this Polaris's - rather than as "no key", which read as calls nobody paid for.
 */

import { useEffect, useState } from "react";
import { IntegrationLogo } from "@/components/logos";
import { RelativeTime } from "@/components/relative-time";
import { Badge, Skeleton, cn } from "@polaris/ui";
import { modelLabel } from "@/components/polar/routing-editor";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import type { RoutingUsage } from "@/lib/polar/routing-screen";
import { useSettingsModels } from "@/components/polar/settings-models";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { ModelSelectorProvider } from "@/components/polar/elements/model-selector";
import Link from "next/link";
import { loadCodeUsageAction, loadRoutingUsageAction, type LabelledCodeUsage } from "./routing-actions";

export function PolarUsageSettings() {
    const { answer } = useSettingsModels();
    return (
        <div className="flex min-w-0 flex-col gap-8">
            <UsageCard providers={answer?.providers ?? null} />
            <CodeUsageCard />
        </div>
    );
}

/** Code sessions: what each agent spent this month and the limits hit. */
function CodeUsageCard() {
    const t = useTranslations("polar");
    const locale = useLocale();
    const [usage, setUsage] = useState<LabelledCodeUsage | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let live = true;
        void loadCodeUsageAction()
            .then((result) => {
                if (!live) return;
                if (result.usage) setUsage(result.usage);
                else setFailed(true);
            })
            .catch(() => (live ? setFailed(true) : undefined));
        return () => {
            live = false;
        };
    }, []);
    const label = (cli: string) => usage?.labels[cli] ?? cli;
    return (
        <section className="flex min-w-0 flex-col gap-4">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t("codeUsage.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("codeUsage.intro")}</p>
            </div>
            {usage ? (
                <>
                    <UsageTable
                        caption={t("codeUsage.byAgent")}
                        first={t("codeUsage.agent")}
                        requestsLabel={t("codeUsage.sessions")}
                        empty={t("codeUsage.empty")}
                        rows={usage.byAgent.map((row) => ({
                            id: row.cli,
                            logo: null,
                            name: label(row.cli),
                            hint: null,
                            detail: null,
                            badge: null,
                            requests: row.sessions,
                            tokens: formatTokens(row.tokens, locale),
                            cost: row.costUsd === null ? "-" : formatUsd(row.costUsd, locale)
                        }))}
                    />
                    <div className="flex min-w-0 flex-col gap-2">
                        <h3 className="text-xs font-medium text-foreground">{t("codeUsage.limits")}</h3>
                        {usage.limits.length === 0 ? (
                            <p className="rounded-md border border-border px-3 py-4 text-center text-xs text-muted-foreground">
                                {t("codeUsage.noLimits")}
                            </p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                                {usage.limits.map((row) => (
                                    <li key={row.id} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
                                        <Link
                                            href={`/polar?session=${encodeURIComponent(row.sessionId)}`}
                                            className="min-w-0 truncate text-sm text-foreground hover:underline"
                                        >
                                            {t(`codeUsage.outcome.${row.outcome}`, { agent: label(row.cli) })}
                                        </Link>
                                        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                                            <RelativeTime iso={row.at} />
                                            {row.resetAt ? (
                                                <span className="inline-flex gap-1">
                                                    {t("codeUsage.resets")}
                                                    <RelativeTime iso={row.resetAt} tense="future" />
                                                </span>
                                            ) : null}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </>
            ) : failed ? (
                <p className="text-xs text-muted-foreground" role="alert">
                    {t("codeUsage.error")}
                </p>
            ) : (
                <div className="flex flex-col gap-2" aria-hidden>
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                </div>
            )}
        </section>
    );
}

const SURFACES = ["chat", "helper", "api", "voice", "translate"] as const;
const REASONS = ["key", "credit", "paid", "rate", "busy", "down", "model"] as const;

function UsageCard({ providers }: { providers: ModelSelectorProvider[] | null }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const [usage, setUsage] = useState<RoutingUsage | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let live = true;
        void loadRoutingUsageAction()
            .then((result) => {
                if (!live) return;
                if (result.usage) setUsage(result.usage);
                else setFailed(true);
            })
            .catch(() => (live ? setFailed(true) : undefined));
        return () => {
            live = false;
        };
    }, []);
    const cost = (amount: number | null) => (amount === null ? "-" : formatUsd(amount, locale));
    const providerName = (slug: string) =>
        providers?.find((entry) => entry.provider === slug)?.name ?? slug;
    const surface = (name: string) =>
        (SURFACES as readonly string[]).includes(name)
            ? t(`routing.usage.surfaces.${name as (typeof SURFACES)[number]}`)
            : name;
    const reason = (kind: string | null) =>
        kind && (REASONS as readonly string[]).includes(kind)
            ? t(`routing.reasons.${kind as (typeof REASONS)[number]}`)
            : t("routing.reasons.other");
    const modelOf = (id: string) => {
        const slash = id.indexOf("/");
        if (slash < 0) return id;
        return modelLabel({ provider: id.slice(0, slash), model: id.slice(slash + 1) }, providers)
            .label;
    };

    return (
        <section className="flex min-w-0 flex-col gap-4">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t("routing.usage.title")}</h2>
                <p className="text-xs text-muted-foreground">{t("routing.usage.intro")}</p>
            </div>
            {usage ? (
                <>
                    <UsageTable
                        caption={t("routing.usage.byKey")}
                        first={t("routing.usage.key")}
                        empty={t("routing.usage.empty")}
                        rows={usage.byKey.map((row) => ({
                            id: `${row.keyId ?? "none"}:${row.provider}:${row.payer}`,
                            logo: row.provider,
                            name: row.keyId
                                ? (row.name ?? t("routing.usage.removedKey"))
                                : row.payer === "instance"
                                  ? t("routing.usage.unitemized.instance")
                                  : t("routing.usage.unitemized.own"),
                            hint: row.keyId ? null : t("routing.usage.unitemized.hint"),
                            detail: providerName(row.provider),
                            badge:
                                row.source === "instance" ? t("routing.usage.deployment") : null,
                            requests: row.requests,
                            tokens: formatTokens(row.tokens, locale),
                            cost: cost(row.costUsd)
                        }))}
                    />
                    <UsageTable
                        caption={t("routing.usage.bySurface")}
                        first={t("routing.usage.surface")}
                        empty={t("routing.usage.empty")}
                        rows={usage.bySurface.map((row) => ({
                            id: row.surface,
                            logo: null,
                            hint: null,
                            name: surface(row.surface),
                            detail: null,
                            badge: null,
                            requests: row.requests,
                            tokens: formatTokens(row.tokens, locale),
                            cost: cost(row.costUsd)
                        }))}
                    />
                    <div className="flex min-w-0 flex-col gap-2">
                        <h3 className="text-xs font-medium text-foreground">
                            {t("routing.usage.fallbacks")}
                        </h3>
                        {usage.fallbacks.length === 0 ? (
                            <p className="rounded-md border border-border px-3 py-4 text-center text-xs text-muted-foreground">
                                {t("routing.usage.noFallbacks")}
                            </p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                                {usage.fallbacks.map((row, index) => (
                                    <li
                                        key={`${row.at}:${index}`}
                                        className="flex min-w-0 flex-col gap-0.5 px-3 py-2"
                                    >
                                        <p className="min-w-0 truncate text-sm text-foreground">
                                            {t("routing.usage.fellBack", {
                                                from: modelOf(row.from),
                                                to: modelOf(`${row.provider}/${row.model}`)
                                            })}
                                        </p>
                                        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                                            <RelativeTime iso={row.at} />
                                            <span>{reason(row.kind)}</span>
                                            <span>{surface(row.surface)}</span>
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </>
            ) : failed ? (
                <p className="text-xs text-muted-foreground" role="alert">
                    {t("routing.errors.usage")}
                </p>
            ) : (
                <div className="flex flex-col gap-2" aria-hidden>
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                </div>
            )}
        </section>
    );
}

function UsageTable({
    caption,
    first,
    empty,
    rows,
    requestsLabel
}: {
    caption: string;
    first: string;
    empty: string;
    /** What the count column counts, when it is not requests. */
    requestsLabel?: string;
    rows: Array<{
        id: string;
        /** The provider whose logo leads the row, if any. */
        logo: string | null;
        name: string;
        /** Said on hover, for a name that needs a word more. */
        hint: string | null;
        detail: string | null;
        badge: string | null;
        requests: number;
        tokens: string;
        cost: string;
    }>;
}) {
    const t = useTranslations("polar");
    const locale = useLocale();
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs font-medium text-foreground">{caption}</h3>
            <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-start">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">{first}</th>
                            <th className="whitespace-nowrap px-3 py-2 text-end font-medium">
                                {requestsLabel ?? t("routing.usage.requests")}
                            </th>
                            <th className="whitespace-nowrap px-3 py-2 text-end font-medium">
                                {t("routing.usage.tokens")}
                            </th>
                            <th className="hidden whitespace-nowrap px-3 py-2 text-end font-medium sm:table-cell">
                                {t("routing.usage.cost")}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">
                                    {empty}
                                </td>
                            </tr>
                        ) : (
                            rows.map((row) => (
                                <tr key={row.id} className="border-t border-border">
                                    <td className="w-full max-w-0 px-3 py-2">
                                        <span className="flex min-w-0 items-center gap-2">
                                            {row.logo ? (
                                                <IntegrationLogo
                                                    slug={row.logo}
                                                    className="size-4 shrink-0"
                                                />
                                            ) : null}
                                            <span
                                                className="min-w-0 truncate"
                                                title={row.hint ? `${row.name} - ${row.hint}` : row.name}
                                            >
                                                {row.name}
                                            </span>
                                            {row.badge ? (
                                                <Badge variant="neutral" className="shrink-0">
                                                    {row.badge}
                                                </Badge>
                                            ) : null}
                                        </span>
                                        {row.detail || row.hint ? (
                                            <span
                                                className={cn(
                                                    "block truncate text-xs text-muted-foreground",
                                                    row.logo && "ps-6"
                                                )}
                                                title={[row.detail, row.hint].filter(Boolean).join(" - ")}
                                            >
                                                {[row.detail, row.hint].filter(Boolean).join(" - ")}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                                        {row.requests.toLocaleString(locale)}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-end tabular-nums">
                                        {row.tokens}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-end tabular-nums sm:table-cell">
                                        {row.cost}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
