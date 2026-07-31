"use client";

/**
 * What actually happened to recent alerts. This is the answer to "the alarm
 * fired, so why did nobody get a text": the bell alone cannot tell a muted rule
 * apart from a webhook that has been failing for a week.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { notificationEvent } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import type { DeliveryView } from "@/lib/notification-service";

const KIND_LABEL: Record<string, string> = {
    inapp: "In-app",
    email: "Email",
    webhook: "Webhook",
    sms: "Text"
};

/** Collapsed by default: it is a diagnostic, not something to read daily. */
export function DeliveryLog({ deliveries }: { deliveries: DeliveryView[] }) {
    const [open, setOpen] = useState(false);
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
                        <CardTitle>Recent deliveries</CardTitle>
                        <p className="text-xs text-muted-foreground">
                            Every attempt to get an alert somewhere, and how it went.
                        </p>
                    </div>
                    {failures > 0 ? <Badge variant="danger">{failures} failed</Badge> : null}
                </button>
            </CardHeader>
            {open ? (
                <CardBody className="p-0">
                    {deliveries.length === 0 ? (
                        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                            Nothing sent yet.
                        </p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {deliveries.map((row) => (
                                <li key={row.id} className="flex flex-col gap-0.5 px-4 py-2">
                                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                        <StatusBadge status={row.status} />
                                        <span className="font-medium">
                                            {notificationEvent(row.event)?.label ?? row.event}
                                        </span>
                                        <span className="text-muted-foreground">
                                            {KIND_LABEL[row.kind] ?? row.kind}
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
    if (status === "failed") return <Badge variant="danger">Failed</Badge>;
    if (status === "skipped") return <Badge>Skipped</Badge>;
    return <Badge variant="success">Sent</Badge>;
}
