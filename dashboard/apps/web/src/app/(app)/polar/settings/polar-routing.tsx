"use client";

/**
 * Two pages of Polar's settings over the same routing: Fallbacks (what a
 * failing call falls back to) and Coding tools (which model a coding tool
 * lands on, and how to point one here). What each key spent is the Usage page
 * (`polar-usage.tsx`).
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
import { useSettingsModels } from "@/components/polar/settings-models";
import { Button, CopyButton, Skeleton, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CodingToolsEditor, FallbackEditor } from "@/components/polar/routing-editor";
import type { RoutingScreen } from "@/lib/polar/routing-screen";
import {
    loadRoutingAction,
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

export function PolarRoutingSettings({ part }: { part: "fallbacks" | "tools" }) {
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
            {screen ? (
                <>
                    {screen.own ? (
                        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
                            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                                {t("routing.own.body")}
                            </p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void reset()}
                            >
                                {t("routing.reset.action")}
                            </Button>
                        </div>
                    ) : (
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
                    {part === "fallbacks" ? (
                        <FallbackEditor
                            value={screen.own ?? screen.deployment}
                            onChange={screen.own ? save : undefined}
                            providers={providers}
                            keys={screen.keys}
                        />
                    ) : (
                        <CodingToolsEditor
                            value={screen.own ?? screen.deployment}
                            onChange={screen.own ? save : undefined}
                            providers={providers}
                        />
                    )}
                </>
            ) : failed ? (
                <LoadFailed onRetry={() => setAttempt((count) => count + 1)} />
            ) : (
                <EditorSkeleton />
            )}
            {part === "tools" ? <ConnectCard /> : null}
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
