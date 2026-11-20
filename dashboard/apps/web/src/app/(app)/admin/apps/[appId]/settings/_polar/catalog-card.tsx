"use client";

/**
 * The model catalogue, and when it was last read.
 *
 * It refreshes itself daily, so this exists for the two moments waiting is the
 * wrong answer: a deployment that has just come up and has nothing yet, and a
 * model released this morning that somebody wants to pick today. The count is
 * here because an empty catalogue is otherwise invisible - the pickers simply
 * offer less, and nobody would know to look.
 */

import { RefreshCw } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { Button, Card, CardBody, Switch, useOptimisticToggle } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { refreshModelCatalogAction, setInstanceKeySharingAction } from "./agent-actions";

/**
 * Whether an account with no key of its own runs on the deployment's.
 *
 * Sits beside the catalogue because both answer the same question from
 * different ends: which models can be picked, and whose account pays when one
 * is. Turning it off does not break a deployment quietly - accounts that have
 * brought their own keys keep working, and the ones that have not are told on
 * their own AI provider keys screen.
 */
export function KeySharingCard({ shared }: { shared: boolean }) {
    const t = useTranslations("admin");
    const [error, setError] = useState<string | null>(null);
    // Optimistic, with the switch put back if the write is refused.
    const [on, toggle] = useOptimisticToggle(
        shared,
        async (next) => {
            setError(null);
            return (
                (await runAction(() => setInstanceKeySharingAction({ shared: next }), setError)) ?? {
                    error: true
                }
            );
        },
        { onRefused: setError }
    );

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">{t("agents.keySharing.label")}</p>
                        <p className="text-muted-foreground text-xs">
                            {on
                                ? t("agents.keySharing.on")
                                : t("agents.keySharing.off")}
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        onChange={toggle}
                        aria-label={t("agents.keySharing.switch")}
                    />
                </div>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

/** The provider index as last read: when, how many providers, the last failure. */
export interface ProviderIndexView {
    refreshedAt: string | null;
    providers: number;
    lastError: string | null;
}

export function CatalogCard({
    models,
    refreshedAt,
    index
}: {
    models: number;
    refreshedAt: string | null;
    index: ProviderIndexView | null;
}) {
    const t = useTranslations("admin");
    const [count, setCount] = useState(models);
    const [at, setAt] = useState(refreshedAt);
    const [indexState, setIndexState] = useState(index);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const format = useDisplayFormat();

    const refresh = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                const result = await runAction(() => refreshModelCatalogAction(), setError);
                if (result?.index !== undefined) setIndexState(result.index);
                if (result?.models !== undefined) {
                    setCount(result.models);
                    setAt(result.at ?? null);
                }
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">{t("agents.catalog.title")}</p>
                        <p className="text-muted-foreground text-xs">
                            {count === 0
                                ? t("agents.catalog.empty")
                                : t("agents.catalog.count", { count, shown: String(count) })}
                        </p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={refresh} disabled={pending}>
                        <RefreshCw className={`size-4 shrink-0 ${pending ? "animate-spin" : ""}`} />
                        {t("agents.catalog.refresh")}
                    </Button>
                </div>
                {at ? (
                    <p className="text-muted-foreground text-xs">
                        {t.rich("agents.catalog.lastRead", {
                            when: format.dateTime(at),
                            time: (chunks) => (
                                <time key="time" dateTime={at}>
                                    {chunks}
                                </time>
                            )
                        })}
                    </p>
                ) : null}
                {indexState?.refreshedAt ? (
                    <p className="text-muted-foreground text-xs">
                        {t.rich("agents.catalog.indexRead", {
                            count: indexState.providers,
                            shown: String(indexState.providers),
                            when: format.dateTime(indexState.refreshedAt),
                            time: (chunks) => (
                                <time key="time" dateTime={indexState.refreshedAt ?? undefined}>
                                    {chunks}
                                </time>
                            )
                        })}
                    </p>
                ) : null}
                {indexState?.lastError ? (
                    <p className="text-xs text-warning break-words">
                        {t("agents.catalog.indexFailed", { error: indexState.lastError })}
                    </p>
                ) : null}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
