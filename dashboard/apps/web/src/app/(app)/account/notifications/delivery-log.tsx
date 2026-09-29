"use client";

/**
 * What actually happened to recent alerts. This is the answer to "the alarm
 * fired, so why did nobody get a text": the bell alone cannot tell a muted rule
 * apart from a webhook that has been failing for a week.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { eventLabel } from "./event-names";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DeliveryView } from "@/lib/notification-service";

/** How each kind of delivery is named on a row. */
const KIND_KEYS = new Set(["inapp", "email", "webhook", "sms"]);

/** Collapsed by default: it is a diagnostic, not something to read daily. */
export function DeliveryLog({ deliveries }: { deliveries: DeliveryView[] }) {
    const [open, setOpen] = useState(false);
    const t = useTranslations("accountNotifications");
    const failures = deliveries.filter((row) => row.status === "failed").length;

    return (
        <Card>
            <CardHeader className="p-0">
                <button
                    type="button"
                    onClick={() => setOpen((current) => !current)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-2 p-4 text-left"
                >
                    {open ? (
                        <ChevronDown className="size-4 text-muted-foreground" />
                    ) : (
                        <ChevronRight className="size-4 text-muted-foreground" />
                    )}
                    <div className="flex-1">
                        <CardTitle>{t("deliveries.title")}</CardTitle>
                        <p className="text-xs text-muted-foreground">{t("deliveries.description")}</p>
                    </div>
                    {failures > 0 ? <Badge variant="danger">{t("deliveries.failedCount", { count: failures })}</Badge> : null}
                </button>
            </CardHeader>
            {open ? (
                <CardBody className="p-0">
                    {deliveries.length === 0 ? (
                        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                            {t("deliveries.empty")}
                        </p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {deliveries.map((row) => (
                                <li key={row.id} className="flex flex-col gap-0.5 px-4 py-2">
                                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                        <StatusBadge status={row.status} />
                                        <span className="font-medium">
                                            {eventLabel(t, row.event) ?? row.event}
                                        </span>
                                        <span className="text-muted-foreground">
                                            {KIND_KEYS.has(row.kind) ? t(`deliveries.kinds.${row.kind}` as "deliveries.kinds.inapp") : row.kind}
                                            {row.destinationHint ? ` - ${row.destinationHint}` : ""}
                                        </span>
                                        <span className="ml-auto text-muted-foreground/70">
                                            <RelativeTime iso={row.createdAt} />
                                        </span>
                                    </div>
                                    {row.detail ? (
                                        <p className="text-xs text-muted-foreground">{row.detail}</p>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            ) : null}
        </Card>
    );
}

function StatusBadge({ status }: { status: string }) {
    const t = useTranslations("accountNotifications");
    if (status === "failed") return <Badge variant="danger">{t("deliveries.status.failed")}</Badge>;
    if (status === "skipped") return <Badge>{t("deliveries.status.skipped")}</Badge>;
    return <Badge variant="success">{t("deliveries.status.sent")}</Badge>;
}
