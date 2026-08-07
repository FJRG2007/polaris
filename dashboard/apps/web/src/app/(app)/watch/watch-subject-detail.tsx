"use client";

/**
 * One monitored thing in full: its history at every range, the alarms watching
 * it, and - for a service - the endpoints its project reports to.
 *
 * This is the screen a card opens, so it answers what a card deliberately does
 * not: exact figures, a choosable window, and what happens when a threshold is
 * crossed.
 */

import Link from "next/link";
import { useState } from "react";
import { Button, cn } from "@polaris/ui";
import type { AlarmView } from "@/lib/watch-service";
import { ArrowLeft, Bell, ExternalLink } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { ProjectWebhooks } from "@/components/project-webhooks";
import { CONSUMPTION_METRICS, MetricsHistory } from "@/components/metrics-history";

const STATE_LABEL: Record<string, string> = { ok: "OK", alarm: "Alarm", insufficient: "No data" };

export function WatchSubjectDetail({
    kind,
    id,
    name,
    detail,
    projectId,
    serviceHref,
    alarms
}: {
    kind: "server" | "service";
    id: string;
    name: string;
    detail: string;
    /** Set for a service, so its project's webhooks can be shown here too. */
    projectId?: string;
    serviceHref?: string;
    alarms: AlarmView[];
}) {
    const display = useDisplayFormat();
    const [tab, setTab] = useState<"metrics" | "alarms" | "webhooks">("metrics");
    const tabs: { id: typeof tab; label: string }[] = [
        { id: "metrics", label: "Metrics" },
        { id: "alarms", label: `Alarms (${alarms.length})` },
        ...(projectId ? [{ id: "webhooks" as const, label: "Webhooks" }] : [])
    ];

    // A server's series is keyed by host id under a subject of its own; a service
    // reuses the endpoint the Deploy panel already reads.
    const endpoint =
        kind === "server" ? `/api/watch/hosts/${id}/metrics/history` : `/api/deploy/apps/${id}/metrics/history`;

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <Link
                        href="/watch"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="size-3" /> Watch
                    </Link>
                    <h1 className="mt-1 truncate text-lg font-semibold">{name}</h1>
                    <p className="truncate text-sm text-muted-foreground">{detail}</p>
                </div>
                {serviceHref && (
                    <Button asChild variant="ghost" size="sm">
                        <Link href={serviceHref}>
                            <ExternalLink className="size-4" /> Open in Deploy
                        </Link>
                    </Button>
                )}
            </div>

            <div className="flex gap-1 border-b border-border/60">
                {tabs.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => setTab(entry.id)}
                        aria-current={tab === entry.id ? "page" : undefined}
                        className={cn(
                            "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
                            tab === entry.id
                                ? "border-primary font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            {tab === "metrics" && (
                <div className="flex flex-col gap-2">
                    <MetricsHistory endpoint={endpoint} metrics={CONSUMPTION_METRICS} />
                    <p className="text-xs text-muted-foreground">
                        {kind === "server"
                            ? "Measured from the containers running on this server, against what the machine has."
                            : "Measured from the service's own container."}
                    </p>
                </div>
            )}

            {tab === "alarms" && (
                <div className="flex flex-col gap-3">
                    {alarms.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 px-4 py-10 text-center">
                            <Bell className="size-5 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">
                                Nothing is watching this yet. An alarm fires when a threshold holds for long enough to
                                mean something.
                            </p>
                            <Button asChild variant="secondary" size="sm">
                                <Link href="/watch/alarms">Create an alarm</Link>
                            </Button>
                        </div>
                    ) : (
                        <div className="overflow-hidden rounded-md border border-border/60">
                            {alarms.map((alarm) => (
                                <div
                                    key={alarm.id}
                                    className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{alarm.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {alarm.metric}
                                            {alarm.threshold != null
                                                ? ` ${alarm.operator === "lt" ? "<" : ">"} ${alarm.threshold}%`
                                                : ""}
                                            {alarm.lastEvaluatedAt
                                                ? ` - checked ${display.dateTime(alarm.lastEvaluatedAt)}`
                                                : " - not evaluated yet"}
                                        </p>
                                    </div>
                                    <span
                                        className={cn(
                                            "shrink-0 rounded-full border px-2 py-0.5 text-xs",
                                            alarm.state === "alarm"
                                                ? "border-danger/40 text-danger"
                                                : alarm.state === "ok"
                                                  ? "border-success/40 text-success"
                                                  : "border-border/60 text-muted-foreground"
                                        )}
                                    >
                                        {STATE_LABEL[alarm.state] ?? alarm.state}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    <Link href="/watch/alarms" className="text-xs text-primary hover:underline">
                        Manage every alarm
                    </Link>
                </div>
            )}

            {tab === "webhooks" && projectId && <ProjectWebhooks projectId={projectId} />}
        </div>
    );
}
