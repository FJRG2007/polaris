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

const UNIT_BYTES = { kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 } as const;

/**
 * A memory setting in bytes, however the engine wrote it: PostgreSQL's `128MB`
 * or `1GB`, MySQL's plain bytes. Null for anything else, such as a count.
 */
export function settingBytes(value: string): number | null {
    const sized = /^(\d+)(kB|MB|GB|TB)$/.exec(value);
    if (sized) return Number(sized[1]) * UNIT_BYTES[sized[2] as keyof typeof UNIT_BYTES];
    return /^\d{7,}$/.test(value) ? Number(value) : null;
}

/** Memory as kB, MB or GB; anything else (a count) as the engine said it. */
export function readableSetting(value: string | null): string {
    if (value === null) return "-";
    const bytes = settingBytes(value);
    if (bytes === null) return value;
    if (bytes < UNIT_BYTES.MB) return `${Math.round(bytes / UNIT_BYTES.kB)}kB`;
    const mb = bytes / UNIT_BYTES.MB;
    return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024}GB` : `${Math.round(mb)}MB`;
}

/** Whether a setting differs from its suggestion: by size for memory, as written for the rest. */
export function settingDiffers(current: string | null, suggested: string): boolean {
    if (current === null) return true;
    const [now, wanted] = [settingBytes(current), settingBytes(suggested)];
    return now !== null && wanted !== null ? now !== wanted : current !== suggested;
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

    const differs = (entry: View["settings"][number]) =>
        settingDiffers(entry.current, entry.suggested);
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
                                    <th className="p-2 font-medium">
                                        {t("database.tuning.setting")}
                                    </th>
                                    <th className="p-2 font-medium">
                                        {t("database.tuning.current")}
                                    </th>
                                    <th className="p-2 font-medium">
                                        {t("database.tuning.suggested")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {view.settings.map((entry) => (
                                    <tr key={entry.name}>
                                        <td className="break-all p-2 font-mono text-xs">
                                            {entry.name}
                                        </td>
                                        <td className="p-2">{readableSetting(entry.current)}</td>
                                        <td className="p-2">
                                            <span className="inline-flex flex-wrap items-center gap-2">
                                                {readableSetting(entry.suggested)}
                                                {differs(entry) ? (
                                                    <Badge>{t("database.tuning.changes")}</Badge>
                                                ) : null}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {view.applyRefusal ? (
                        <p className="text-xs text-muted-foreground">
                            {t(`database.tuning.refusal.${view.applyRefusal}`)}
                        </p>
                    ) : manage ? (
                        <div>
                            <Button
                                size="sm"
                                disabled={changes.length === 0}
                                title={
                                    changes.length === 0 ? t("database.tuning.upToDate") : undefined
                                }
                                onClick={() =>
                                    ask({
                                        title: t("database.tuning.applyTitle"),
                                        body: t("database.tuning.applyBody"),
                                        label: t("database.tuning.applyConfirm"),
                                        run: async () => {
                                            const result =
                                                await actions.applyDatabaseTuningAction(databaseId);
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
