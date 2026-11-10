"use client";

/**
 * The Routing section of Polar's settings: what a failing call falls back to,
 * which model a coding tool lands on, how to point a coding tool here, and
 * what each key spent this month.
 *
 * A person who set nothing follows the deployment's routing, shown read-only
 * with a way to start from it. The last routing seen is drawn at once from the
 * tab and replaced by the server's.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAppUrl } from "@/components/app-url";
import type { PolarRouting } from "@/lib/polar/routing";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import { useSettingsModels } from "@/components/polar/settings-models";
import { Badge, Button, CopyButton, Skeleton, useToast } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { RoutingEditor, modelLabel } from "@/components/polar/routing-editor";
import type { RoutingScreen, RoutingUsage } from "@/lib/polar/routing-screen";
import type { ModelSelectorProvider } from "@/components/polar/elements/model-selector";
import {
    loadRoutingAction,
    loadRoutingUsageAction,
    resetRoutingAction,
    saveRoutingAction
} from "./routing-actions";

const CACHE_KEY = "polar.routingScreen";

function readCache(): RoutingScreen | null {
    try {
        const raw = window.sessionStorage.getItem(CACHE_KEY);
        return raw ? (JSON.parse(raw) as RoutingScreen) : null;
    } catch {
        return null;
    }
}

function writeCache(screen: RoutingScreen) {
    try {
        window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(screen));
    } catch {
        // Not cached; the next visit reads it again.
    }
}

export function PolarRoutingSettings() {
    const t = useTranslations("polar");
    const toast = useToast();
    const { answer } = useSettingsModels();
    const providers = answer?.providers ?? null;
    const [confirm, confirmElement] = useConfirm();
    const [screen, setScreen] = useState<RoutingScreen | null>(null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const cached = readCache();
        if (cached) setScreen(cached);
        let live = true;
        void loadRoutingAction()
            .then((result) => {
                if (!live) return;
                if (result.screen) {
                    setScreen(result.screen);
                    setFailed(false);
                    writeCache(result.screen);
                } else setFailed(true);
            })
            .catch(() => (live ? setFailed(true) : undefined));
        return () => {
            live = false;
        };
    }, [attempt]);

    const commit = (own: PolarRouting | null, save: () => Promise<{ error?: string }>) => {
        if (!screen) return;
        const before = screen;
        const next = { ...screen, own };
        // Shown at once, put back if the server did not keep it.
        setScreen(next);
        void save()
            .catch(() => ({ error: t("routing.errors.failed") }))
            .then((result) => {
                if (result.error) {
                    setScreen(before);
                    toast.show({ title: result.error });
                    return;
                }
                writeCache(next);
            });
    };
    const save = (routing: PolarRouting) => commit(routing, () => saveRoutingAction(routing));
    const reset = async () => {
        const ok = await confirm({
            title: t("routing.reset.title"),
            description: t("routing.reset.body"),
            confirmLabel: t("routing.reset.confirm"),
            danger: true
        });
        if (ok) commit(null, () => resetRoutingAction());
    };

    return (
        <section className="flex min-w-0 flex-col gap-6">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium text-foreground">{t("routing.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("routing.intro")}</p>
                </div>
                {screen?.own ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => void reset()}>
                        {t("routing.reset.action")}
                    </Button>
                ) : null}
            </div>
            {screen ? (
                <>
                    {screen.own ? null : (
                        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <p className="text-sm text-foreground">
                                    {t("routing.following.title")}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t("routing.following.body")}
                                </p>
                            </div>
                            <Button type="button" size="sm" onClick={() => save(screen.deployment)}>
                                {t("routing.following.customize")}
                            </Button>
                        </div>
                    )}
                    <RoutingEditor
                        value={screen.own ?? screen.deployment}
                        onChange={screen.own ? save : undefined}
                        providers={providers}
                        keys={screen.keys}
                    />
                </>
            ) : failed ? (
                <LoadFailed onRetry={() => setAttempt((count) => count + 1)} />
            ) : (
                <EditorSkeleton />
            )}
            <ConnectCard />
            <UsageCard providers={providers} />
            {confirmElement}
        </section>
    );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
    const t = useTranslations("polar");
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-border px-3 py-3">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground" role="alert">
                {t("routing.errors.load")}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                {t("routing.retry")}
            </Button>
        </div>
    );
}

function EditorSkeleton() {
    return (
        <div className="flex flex-col gap-6" aria-hidden>
            <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <div className="flex flex-col gap-2 rounded-md border border-border p-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                </div>
            </div>
            <Skeleton className="h-12 w-full" />
            <div className="flex flex-col gap-2 rounded-md border border-border p-2">
                {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton key={index} className="h-9 w-full" />
                ))}
            </div>
        </div>
    );
}

/** The two endpoints a coding tool is pointed at, on the deployment's own
 *  address, and where the key it signs in with is made. */
function ConnectCard() {
    const t = useTranslations("polar");
    const base = useAppUrl().replace(/\/+$/, "");
    const endpoints = [
        {
            id: "anthropic",
            title: t("routing.connect.anthropic"),
            hint: t("routing.connect.anthropicHint"),
            url: `${base}/api`,
            variables: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
        },
        {
            id: "openai",
            title: t("routing.connect.openai"),
            hint: t("routing.connect.openaiHint"),
            url: `${base}/api/v1`,
            variables: []
        }
    ];
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">
                    {t("routing.connect.title")}
                </h3>
                <p className="text-xs text-muted-foreground">{t("routing.connect.intro")}</p>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {endpoints.map((endpoint) => (
                    <li key={endpoint.id} className="flex min-w-0 flex-col gap-1 px-3 py-2">
                        <p className="text-sm text-foreground">{endpoint.title}</p>
                        <p className="text-xs text-muted-foreground">{endpoint.hint}</p>
                        <div className="flex min-w-0 items-center gap-2 rounded-md bg-field px-2 py-1">
                            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={endpoint.url}>
                                {endpoint.url}
                            </code>
                            <CopyButton value={endpoint.url} label={endpoint.title} />
                        </div>
                        {endpoint.variables.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                                <span>{t("routing.connect.variables")}</span>
                                {endpoint.variables.map((name) => (
                                    <span key={name} className="inline-flex items-center gap-1">
                                        <code className="rounded bg-field px-1 font-mono">{name}</code>
                                        <CopyButton value={name} />
                                    </span>
                                ))}
                            </div>
                        ) : null}
                    </li>
                ))}
                <li className="px-3 py-2 text-xs text-muted-foreground">
                    {t.rich("routing.connect.key", {
                        link: (chunks) => (
                            <Link
                                key="link"
                                href="/account/api-keys"
                                className="text-primary hover:underline"
                            >
                                {chunks}
                            </Link>
                        )
                    })}
                </li>
            </ul>
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
                <h3 className="text-sm font-medium text-foreground">{t("routing.usage.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("routing.usage.intro")}</p>
            </div>
            {usage ? (
                <>
                    <UsageTable
                        caption={t("routing.usage.byKey")}
                        first={t("routing.usage.key")}
                        empty={t("routing.usage.empty")}
                        rows={usage.byKey.map((row) => ({
                            id: `${row.keyId ?? "none"}:${row.provider}`,
                            name: row.keyId
                                ? (row.name ?? t("routing.usage.removedKey"))
                                : t("routing.usage.noKey"),
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
                            name: surface(row.surface),
                            detail: null,
                            badge: null,
                            requests: row.requests,
                            tokens: formatTokens(row.tokens, locale),
                            cost: cost(row.costUsd)
                        }))}
                    />
                    <div className="flex min-w-0 flex-col gap-2">
                        <h4 className="text-xs font-medium text-foreground">
                            {t("routing.usage.fallbacks")}
                        </h4>
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
    rows
}: {
    caption: string;
    first: string;
    empty: string;
    rows: Array<{
        id: string;
        name: string;
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
            <h4 className="text-xs font-medium text-foreground">{caption}</h4>
            <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">{first}</th>
                            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                                {t("routing.usage.requests")}
                            </th>
                            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                                {t("routing.usage.tokens")}
                            </th>
                            <th className="hidden whitespace-nowrap px-3 py-2 text-right font-medium sm:table-cell">
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
                                            <span className="min-w-0 truncate" title={row.name}>
                                                {row.name}
                                            </span>
                                            {row.badge ? (
                                                <Badge variant="neutral" className="shrink-0">
                                                    {row.badge}
                                                </Badge>
                                            ) : null}
                                        </span>
                                        {row.detail ? (
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {row.detail}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                        {row.requests.toLocaleString(locale)}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                                        {row.tokens}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-right tabular-nums sm:table-cell">
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
