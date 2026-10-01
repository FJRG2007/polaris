"use client";

/**
 * Deleted calendars and events: restore one, delete one for good, or empty the
 * lot. What is left goes by itself after the retention period, and each row
 * says when.
 */

import { ColorDot } from "./ui";
import { useCalendarT } from "./i18n";
import { useEffect, useState } from "react";
import * as trashActions from "../actions/trash";
import type { TrashItemView } from "../lib/wire";
import { hostUi } from "@polaris/app-host/client";
import { cacheKey, dropCached, unwrap, useCachedRead } from "./cached-read";
import * as preferenceActions from "../actions/preferences";
import type { CalendarPreferences } from "../lib/preferences";
import { displayZone, formatInstant } from "./time";
import { CalendarDays, RotateCcw, Trash2 } from "lucide-react";
import { Button, EmptyState, Skeleton, useToast } from "@polaris/ui";

export function TrashView() {
    const t = useCalendarT();
    const toast = useToast();
    const locale = hostUi.i18nProvider.useLocale();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [items, setItems] = useState<TrashItemView[] | null>(null);
    const [retention, setRetention] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [turn, setTurn] = useState(0);
    const format = hostUi.displayFormat.useDisplayFormat();
    const preferencesRead = useCachedRead<CalendarPreferences>(cacheKey("preferences"), async () => (await unwrap(() => preferenceActions.loadPreferencesAction(), t("screen.failed"))).preferences);
    const zone = displayZone(preferencesRead.data?.timezone ?? "auto", format.preferences.timeZone);

    useEffect(() => {
        let live = true;
        setError(null);
        unwrap(() => trashActions.listTrashAction(), t("screen.failed"))
            .then((answer) => {
                if (!live) return;
                setItems(answer.items);
                setRetention(answer.retentionDays);
            })
            .catch((caught: unknown) => live && setError(caught instanceof Error ? caught.message : String(caught)));
        return () => {
            live = false;
        };
    }, [turn, t]);

    const titleOf = (item: TrashItemView) => item.title || (item.kind === "calendar" ? t("trashPage.untitledCalendar") : t("screen.untitled"));

    const act = async (item: TrashItemView, kind: "restore" | "purge") => {
        if (busy) return;
        if (kind === "purge") {
            const ok = await confirm({ title: t("trashPage.purgeTitle", { title: titleOf(item) }), description: t("trashPage.purgeBody"), confirmLabel: t("trashPage.purge"), danger: true });
            if (!ok) return;
        }
        const previous = items;
        setBusy(`${item.kind}:${item.id}`);
        setItems((current) => current?.filter((entry) => !(entry.kind === item.kind && entry.id === item.id)) ?? null);
        try {
            if (kind === "restore") await unwrap(() => trashActions.restoreTrashAction({ kind: item.kind, id: item.id, zone }), t("screen.failed"));
            else await unwrap(() => trashActions.purgeTrashAction({ kind: item.kind, id: item.id }), t("screen.failed"));
            dropCached("range");
            dropCached("calendars");
            toast.show({ key: "calendar-trash", title: kind === "restore" ? t("trashPage.restored", { title: titleOf(item) }) : t("trashPage.purged", { title: titleOf(item) }) });
        } catch (caught) {
            setItems(previous);
            toast.show({ key: "calendar-trash-failed", title: kind === "restore" ? t("trashPage.restoreFailed") : t("trashPage.purgeFailed"), body: caught instanceof Error ? caught.message : undefined });
        } finally {
            setBusy(null);
        }
    };

    const empty = async () => {
        if (!items?.length || busy) return;
        const ok = await confirm({ title: t("trashPage.emptyTitle"), description: t("trashPage.emptyBody", { count: items.length }), confirmLabel: t("trashPage.empty"), danger: true });
        if (!ok) return;
        const previous = items;
        setBusy("all");
        setItems([]);
        try {
            await unwrap(() => trashActions.emptyTrashAction(), t("screen.failed"));
            toast.show({ key: "calendar-trash", title: t("trashPage.emptied") });
        } catch (caught) {
            setItems(previous);
            toast.show({ key: "calendar-trash-failed", title: t("trashPage.emptyFailed"), body: caught instanceof Error ? caught.message : undefined });
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">{retention !== null ? t("trashPage.retention", { count: retention }) : " "}</p>
                <Button size="sm" variant="outline" aria-disabled={!items?.length || busy !== null} title={!items?.length ? t("trashPage.nothing") : undefined} onClick={() => void empty()}>
                    <Trash2 />
                    {t("trashPage.empty")}
                </Button>
            </div>
            {error && !items ? (
                <div role="alert" className="flex flex-col items-start gap-2">
                    <p className="text-[0.8125rem]">{t("trashPage.loadFailed")}</p>
                    <p className="text-xs text-muted-foreground">{error}</p>
                    <Button size="sm" variant="outline" onClick={() => setTurn((value) => value + 1)}>
                        {t("screen.retry")}
                    </Button>
                </div>
            ) : !items ? (
                <div className="flex flex-col gap-2" aria-hidden>
                    {[0, 1, 2].map((index) => (
                        <Skeleton key={index} className="h-10 w-full" />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <EmptyState icon={<CalendarDays />} title={t("trashPage.emptyState")} description={t("trashPage.emptyStateHint")} />
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[32rem] text-[0.8125rem]">
                        <thead>
                            <tr className="border-b border-border">
                                <th className="px-3 py-2 text-left">{t("trashPage.item")}</th>
                                <th className="px-3 py-2 text-left">{t("trashPage.deletedAt")}</th>
                                <th className="px-3 py-2 text-left">{t("trashPage.goesAt")}</th>
                                <th className="px-3 py-2 text-right">
                                    <span className="sr-only">{t("trashPage.actions")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((item) => {
                                const title = titleOf(item);
                                return (
                                    <tr key={`${item.kind}:${item.id}`} className="border-b border-border last:border-b-0">
                                        <td className="w-full max-w-0 px-3 py-2">
                                            <span className="flex min-w-0 items-center gap-2">
                                                <ColorDot color={item.color} />
                                                <span className="min-w-0 truncate" title={title}>
                                                    {title}
                                                </span>
                                            </span>
                                            <span className="block truncate text-xs text-foreground-subtle">{item.kind === "calendar" ? t("trashPage.kindCalendar") : t("trashPage.inCalendar", { name: item.calendarName })}</span>
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground tabular-nums">{formatInstant(item.deletedAt, locale, zone, { dateStyle: "medium", timeStyle: "short" })}</td>
                                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground tabular-nums">{formatInstant(item.purgeAt, locale, zone, { dateStyle: "medium" })}</td>
                                        <td className="whitespace-nowrap px-3 py-2 text-right">
                                            <Button size="icon-sm" variant="ghost" aria-label={t("trashPage.restore", { title })} title={t("trashPage.restore", { title })} disabled={busy !== null} onClick={() => void act(item, "restore")}>
                                                <RotateCcw />
                                            </Button>
                                            <Button size="icon-sm" variant="ghost" aria-label={t("trashPage.purgeOne", { title })} title={t("trashPage.purgeOne", { title })} disabled={busy !== null} onClick={() => void act(item, "purge")}>
                                                <Trash2 />
                                            </Button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {confirmElement}
        </div>
    );
}
