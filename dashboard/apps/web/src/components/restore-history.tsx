"use client";

/**
 * A History button for one object's settings - a service's routes or jobs, a
 * scope's variables or firewall, a DNS zone - that opens its restore points with
 * what each would change against the present, and restores one after the reader
 * confirms it in place.
 *
 * Only shown to somebody who may change the object (`canRestore`): the list is
 * readable by anyone who can see it, the Restore button only by an editor, and
 * the server checks both with the same capability its editor uses.
 */

import { useRouter } from "next/navigation";
import { History, Loader2 } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import type { RestorePointView } from "@/lib/restore-points/service";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    listHistoryAction,
    restoreHistoryAction,
    type HistoryTarget
} from "@/app/(app)/apps/deploy/restore-actions";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Skeleton, cn } from "@polaris/ui";

const CHANGE_TONE = {
    added: "text-success-ink",
    removed: "text-danger-ink",
    changed: "text-warning-ink"
} as const;

export function RestoreHistoryButton({
    target,
    canRestore,
    onRestored
}: {
    target: HistoryTarget;
    canRestore: boolean;
    /** Called after a restore, for an editor that holds its own copy of the state. */
    onRestored?: () => void;
}) {
    const t = useTranslations("deploySafety");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
                <History className="size-3.5" />
                {t("history.open")}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{t("history.title")}</DialogTitle>
                        <DialogDescription>{t("history.description")}</DialogDescription>
                    </DialogHeader>
                    {open && <HistoryList target={target} canRestore={canRestore} onRestored={onRestored} />}
                </DialogContent>
            </Dialog>
        </>
    );
}

function HistoryList({
    target,
    canRestore,
    onRestored
}: {
    target: HistoryTarget;
    canRestore: boolean;
    onRestored?: () => void;
}) {
    const t = useTranslations("deploySafety");
    const locale = useLocale();
    const router = useRouter();
    const [points, setPoints] = useState<RestorePointView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

    useEffect(() => {
        let live = true;
        void listHistoryAction(target).then((result) => {
            if (!live) return;
            if (result.error || !result.points) setError(t("history.unavailable"));
            else setPoints(result.points);
        });
        return () => {
            live = false;
        };
        // The target is a fresh object each render; what identifies it is its content.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(target)]);

    function restore(id: string) {
        setError(null);
        setNotice(null);
        startTransition(async () => {
            const result = await restoreHistoryAction(target, id);
            setConfirming(null);
            if (result.error) {
                setError(t("history.restoreFailed"));
                return;
            }
            setNotice(t("history.restored"));
            onRestored?.();
            router.refresh();
            const fresh = await listHistoryAction(target);
            if (fresh.points) setPoints(fresh.points);
        });
    }

    if (points === null && !error) {
        return (
            <div className="flex flex-col gap-2" aria-busy>
                {[0, 1, 2].map((index) => (
                    <Skeleton key={index} className="h-14 w-full" />
                ))}
            </div>
        );
    }
    return (
        <div className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto">
            {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p>}
            {notice && <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success-ink">{notice}</p>}
            {points?.length === 0 && <p className="text-sm text-muted-foreground">{t("history.empty")}</p>}
            {points?.map((point) => {
                const date = when.format(new Date(point.createdAt));
                return (
                    <section key={point.id} className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0 text-sm">
                                <span className="font-medium">{date}</span>
                                <span className="text-muted-foreground">
                                    {" - "}
                                    {point.reason === "restore" ? t("history.reasonRestore") : t("history.reasonChange")}
                                    {point.actorName ? ` ${t("history.by", { name: point.actorName })}` : ""}
                                </span>
                            </div>
                            {canRestore && point.changes.length > 0 && confirming !== point.id && (
                                <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(point.id)}>
                                    {t("history.restore")}
                                </Button>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {point.changes.length === 0
                                ? t("history.same")
                                : t("history.changeCount", { count: point.changes.length })}
                        </p>
                        {point.changes.length > 0 && (
                            <ul className="flex flex-col gap-1 text-xs">
                                {point.changes.map((change) => (
                                    <li key={`${change.kind}:${change.item}`} className="min-w-0">
                                        <span className={cn("font-medium", CHANGE_TONE[change.kind])}>
                                            {t(`history.${change.kind}`)}
                                        </span>{" "}
                                        <code className="break-all">{change.item}</code>
                                        {change.fields.map((field) => (
                                            <div key={field.field} className="ml-3 break-all text-muted-foreground">
                                                {field.field}: {field.after ?? t("history.empty_value")}
                                                {change.kind === "changed" && (
                                                    <span className="line-through opacity-70">
                                                        {" "}
                                                        {field.before ?? t("history.empty_value")}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {confirming === point.id && (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
                                <p className="min-w-0 text-sm">{t("history.confirm", { date })}</p>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(null)}>
                                        {t("history.cancel")}
                                    </Button>
                                    <Button size="sm" disabled={pending} onClick={() => restore(point.id)}>
                                        {pending && <Loader2 className="size-3.5 animate-spin" />}
                                        {t("history.restore")}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
