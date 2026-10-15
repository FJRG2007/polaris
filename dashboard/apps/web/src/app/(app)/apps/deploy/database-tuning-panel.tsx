"use client";

/**
 * A database's Tuning tab: what it runs with next to what its memory suggests,
 * and saving the suggestion - which restarts it, so that is confirmed first in
 * the panel's own dialog.
 */

import { RefreshCw } from "lucide-react";
import * as actions from "./database-actions";
import { Badge, Button, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useState, type ReactNode } from "react";

interface Confirmation {
    title: string;
    body: ReactNode;
    label: string;
    danger?: boolean;
    run: () => Promise<{ error?: string }>;
}

type View = NonNullable<Awaited<ReturnType<typeof actions.databaseTuningAction>>["tuning"]>;

/** Bytes as MB or GB; anything else (a count, `128MB`) as the engine said it. */
export function readableSetting(value: string | null): string {
    if (value === null) return "-";
    if (!/^\d{7,}$/.test(value)) return value;
    const mb = Number(value) / (1024 * 1024);
    return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024}GB` : `${Math.round(mb)}MB`;
}

export function TuningSection({
    databaseId,
    manage,
    ask
}: {
    databaseId: string;
    manage: boolean;
    ask: (confirmation: Confirmation) => void;
}) {
    const t = useTranslations("deployData");
    const [view, setView] = useState<View | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        const result = await actions.databaseTuningAction(databaseId);
        if (result.tuning) {
            setView(result.tuning);
            setError(null);
        } else setError(result.error ?? t("database.tuning.unreadable"));
    }, [databaseId]);

    useEffect(() => {
        void load();
    }, [load]);

    const differs = (entry: View["settings"][number]) => readableSetting(entry.current) !== readableSetting(entry.suggested);
    const changes = view ? view.settings.filter(differs) : [];
    const memory = view ? readableSetting(String(view.ramMb * 1024 * 1024)) : "";

    return (
        <section className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-medium">{t("database.tuning.title")}</h3>
                {view ? (
                    <p className="text-xs text-muted-foreground">
                        {view.ramSource === "limit"
                            ? t("database.tuning.fromLimit", { size: memory })
                            : t("database.tuning.fromContainer", { size: memory })}
                    </p>
                ) : null}
            </div>
            {error ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-0 text-danger">{error}</span>
                    <Button size="sm" variant="ghost" onClick={() => void load()}>
                        <RefreshCw className="size-4" />
                        {t("database.users.retry")}
                    </Button>
                </div>
            ) : null}
            {!view && !error ? <Skeleton className="h-40 w-full" /> : null}
            {view ? (
                <>
                    <div className="max-h-96 overflow-auto overscroll-contain rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="p-2 font-medium">{t("database.tuning.setting")}</th>
                                    <th className="p-2 font-medium">{t("database.tuning.current")}</th>
                                    <th className="p-2 font-medium">{t("database.tuning.suggested")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {view.settings.map((entry) => (
                                    <tr key={entry.name}>
                                        <td className="break-all p-2 font-mono text-xs">{entry.name}</td>
                                        <td className="p-2">{readableSetting(entry.current)}</td>
                                        <td className="p-2">
                                            <span className="inline-flex flex-wrap items-center gap-2">
                                                {readableSetting(entry.suggested)}
                                                {differs(entry) ? <Badge>{t("database.tuning.changes")}</Badge> : null}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {view.applyRefusal ? (
                        <p className="text-xs text-muted-foreground">
                            {t("database.tuning.notSupported", { reason: view.applyRefusal })}
                        </p>
                    ) : manage ? (
                        <div>
                            <Button
                                size="sm"
                                disabled={changes.length === 0}
                                title={changes.length === 0 ? t("database.tuning.upToDate") : undefined}
                                onClick={() =>
                                    ask({
                                        title: t("database.tuning.applyTitle"),
                                        body: t("database.tuning.applyBody"),
                                        label: t("database.tuning.applyConfirm"),
                                        run: async () => {
                                            const result = await actions.applyDatabaseTuningAction(databaseId);
                                            if (!result.error) await load();
                                            return result;
                                        }
                                    })
                                }
                            >
                                {t("database.tuning.apply")}
                            </Button>
                        </div>
                    ) : null}
                </>
            ) : null}
        </section>
    );
}
