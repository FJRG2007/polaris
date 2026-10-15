"use client";

/**
 * One endpoint's deliveries over the last thirty days, newest first, a page at a
 * time, each one sendable again. Loaded when opened rather than with the page:
 * most visits never open a log.
 */

import { deliveryReason } from "./delivery-reason";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { listOutboundDeliveriesAction, redeliverOutboundAction } from "./actions";
import type { OutboundDeliveryView, OutboundHookView } from "@/lib/notifications/outbound-hooks";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

const STATUS_VARIANT = { sent: "success", pending: "warning", failed: "danger" } as const;

export function DeliveryLogDialog({
    hook,
    onClose
}: {
    hook: OutboundHookView;
    onClose: () => void;
}) {
    const t = useTranslations("accountNotifications");
    const [items, setItems] = useState<OutboundDeliveryView[] | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [rowNote, setRowNote] = useState<{ id: string; ok: boolean; text: string } | null>(null);

    const load = useCallback(
        async (from: string | null) => {
            setLoading(true);
            setFailed(false);
            try {
                const result = await listOutboundDeliveriesAction(hook.id, from);
                if (!result.page) throw new Error(result.error);
                const page = result.page;
                setItems((current) => (from ? [...(current ?? []), ...page.items] : page.items));
                setCursor(page.nextCursor);
            } catch {
                setFailed(true);
            } finally {
                setLoading(false);
            }
        },
        [hook.id]
    );

    useEffect(() => {
        void load(null);
    }, [load]);

    async function redeliver(delivery: OutboundDeliveryView) {
        setBusy(delivery.id);
        setRowNote(null);
        try {
            const result = await redeliverOutboundAction(delivery.id);
            if (!result.delivery) {
                setRowNote({
                    id: delivery.id,
                    ok: false,
                    text: result.error ?? t("webhooks.errors.notSaved")
                });
                return;
            }
            const fresh = result.delivery;
            setItems((current) => [fresh, ...(current ?? [])]);
            setRowNote(
                result.status === "sent"
                    ? { id: fresh.id, ok: true, text: t("webhooks.deliveries.redelivered") }
                    : { id: fresh.id, ok: false, text: deliveryReason(t, fresh) }
            );
        } catch {
            setRowNote({ id: delivery.id, ok: false, text: t("webhooks.errors.notSaved") });
        } finally {
            setBusy(null);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="truncate">
                        {t("webhooks.deliveries.title", { name: hook.name })}
                    </DialogTitle>
                    <DialogDescription>{t("webhooks.deliveries.description")}</DialogDescription>
                </DialogHeader>
                <div className="max-h-[60vh] min-w-0 overflow-y-auto overscroll-contain">
                    {items === null && !failed ? (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            {[0, 1, 2, 3].map((row) => (
                                <Skeleton key={row} className="h-12 w-full" />
                            ))}
                        </div>
                    ) : items !== null && items.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            {t("webhooks.deliveries.empty")}
                        </p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {(items ?? []).map((delivery) => (
                                <li key={delivery.id} className="flex flex-col gap-1 py-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex min-w-0 flex-1 items-center gap-2">
                                            <Badge variant={STATUS_VARIANT[delivery.status]}>
                                                {t(`webhooks.deliveries.status.${delivery.status}`)}
                                            </Badge>
                                            <code
                                                className="min-w-0 truncate font-mono text-xs"
                                                title={delivery.event}
                                            >
                                                {delivery.event}
                                            </code>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                            <RelativeTime iso={delivery.createdAt} />
                                            <span>
                                                {t("webhooks.deliveries.attempts", {
                                                    count: delivery.attempts
                                                })}
                                            </span>
                                            {delivery.durationMs !== null ? (
                                                <span>
                                                    {t("webhooks.deliveries.took", {
                                                        ms: delivery.durationMs
                                                    })}
                                                </span>
                                            ) : null}
                                            <Button
                                                size="xs"
                                                variant="outline"
                                                disabled={
                                                    busy !== null || delivery.status === "pending"
                                                }
                                                onClick={() => void redeliver(delivery)}
                                            >
                                                {t("webhooks.deliveries.redeliver")}
                                            </Button>
                                        </div>
                                    </div>
                                    {delivery.error ? (
                                        <p className="text-xs text-danger">
                                            {deliveryReason(t, delivery)}
                                        </p>
                                    ) : null}
                                    {delivery.status === "pending" && delivery.nextAttemptAt ? (
                                        <p className="text-xs text-muted-foreground">
                                            {t.rich("webhooks.deliveries.nextTry", {
                                                time: (
                                                    <RelativeTime
                                                        key="time"
                                                        iso={delivery.nextAttemptAt}
                                                    />
                                                )
                                            })}
                                        </p>
                                    ) : null}
                                    {rowNote?.id === delivery.id ? (
                                        <p
                                            className={
                                                rowNote.ok
                                                    ? "text-xs text-success"
                                                    : "text-xs text-danger"
                                            }
                                        >
                                            {rowNote.text}
                                        </p>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    {failed ? (
                        <div className="flex items-center justify-center gap-2 py-4 text-sm text-danger">
                            {t("webhooks.deliveries.loadFailed")}
                            <Button
                                size="xs"
                                variant="outline"
                                onClick={() => void load(items ? cursor : null)}
                            >
                                {t("webhooks.deliveries.retry")}
                            </Button>
                        </div>
                    ) : null}
                    {cursor && !failed ? (
                        <div className="flex justify-center py-2">
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={loading}
                                onClick={() => void load(cursor)}
                            >
                                {t("webhooks.deliveries.more")}
                            </Button>
                        </div>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}
