"use client";

/**
 * Events as a stream: a project's, or one issue's, newest first and read a
 * page at a time as it scrolls. Opening one shows it whole, in place.
 */

import Link from "next/link";
import * as polls from "./telemetry-polls";
import { EventPanel } from "./event-detail";
import { LEVEL_TONE } from "./issue-stream";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useCursorList } from "./use-cursor-list";
import { cn, EmptyState, Skeleton } from "@polaris/ui";
import { ArrowLeft, Activity, Layers, Tag } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { EventDetail } from "@/lib/telemetry/report-service";
import type { EventRow } from "@/lib/telemetry/workflow-service";

const ROW_HEIGHT = 52;

export function EventStream({
    projectId,
    issueId,
    hrefFor
}: {
    projectId: string;
    issueId?: string | null;
    hrefFor: (event: EventRow) => string;
}) {
    const t = useTranslations("telemetry");
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    const list = useCursorList<EventRow>(
        (cursor, signal) => polls.telemetryEvents({ projectId, issueId: issueId ?? null, cursor }, signal),
        `${projectId}|${issueId ?? ""}`
    );
    const rows = list.items;
    const virtualizer = useVirtualizer({
        count: rows?.length ?? 0,
        getScrollElement: () => scroller,
        estimateSize: () => ROW_HEIGHT,
        overscan: 8,
        initialRect: { width: 800, height: ROW_HEIGHT * 8 }
    });
    const items = virtualizer.getVirtualItems();
    const lastIndex = items[items.length - 1]?.index ?? -1;
    useEffect(() => {
        if (rows && list.more && !list.paging && lastIndex >= rows.length - 8) list.loadMore();
    }, [rows, list, lastIndex]);

    if (rows === null) {
        return (
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-busy="true">
                {Array.from({ length: 5 }, (_, at) => (
                    <div key={at} className="flex items-center gap-3 px-3 py-3">
                        <Skeleton className="size-2 rounded-full" />
                        <Skeleton className="h-3.5 flex-1" />
                        <Skeleton className="h-3 w-16" />
                    </div>
                ))}
            </div>
        );
    }
    if (rows.length === 0) {
        return (
            <>
                {list.error && <p role="alert" className="text-sm text-danger">{list.error}</p>}
                <EmptyState icon={<Activity />} title={t("events.none")} description={t("events.noneHint")} />
            </>
        );
    }
    return (
        <div className="overflow-hidden rounded-lg border border-border">
            {list.error && <p role="alert" className="px-3 py-2 text-sm text-danger">{list.error}</p>}
            <div ref={setScroller} className="max-h-[calc(100dvh-18rem)] min-h-40 overflow-y-auto overscroll-contain">
                <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
                    {items.map((item) => {
                        const row = rows[item.index]!;
                        return (
                            <li
                                key={row.id}
                                data-index={item.index}
                                ref={virtualizer.measureElement}
                                className="absolute inset-x-0 border-b border-border last:border-b-0"
                                style={{ transform: `translateY(${item.start}px)` }}
                            >
                                <Link
                                    href={hrefFor(row)}
                                    className="flex min-w-0 items-center gap-3 px-3 py-2 transition-colors hover:bg-muted"
                                >
                                    <span
                                        aria-hidden="true"
                                        className={cn("size-2 shrink-0 rounded-full", LEVEL_TONE[row.level] ?? LEVEL_TONE.error)}
                                    />
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="truncate text-sm" title={row.message}>
                                            {row.message}
                                        </span>
                                        <span className="truncate text-xs text-muted-foreground">
                                            {[row.environment, row.release, row.userLabel, row.culprit]
                                                .filter(Boolean)
                                                .join(" - ") || t("issue.notStated")}
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        <RelativeTime iso={row.at} />
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
                {list.paging && (
                    <div className="px-3 py-3" aria-busy="true">
                        <Skeleton className="h-3.5 w-1/2" />
                    </div>
                )}
            </div>
        </div>
    );
}

/** One event whole, opened from a stream. */
export function EventView({
    projectId,
    eventId,
    backHref,
    issueHref
}: {
    projectId: string;
    eventId: string;
    backHref: string;
    issueHref: (issueId: string) => string;
}) {
    const t = useTranslations("telemetry");
    const [event, setEvent] = useState<EventDetail | null>(null);
    const [issueId, setIssueId] = useState<string | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let live = true;
        setEvent(null);
        void runAction(() => polls.telemetryEvent({ projectId, eventId }), setError).then((result) => {
            if (!live || !result) return;
            if (result.error) setError(result.error);
            setEvent(result.event ?? null);
            setIssueId(result.event?.issueId ?? null);
        });
        return () => {
            live = false;
        };
    }, [projectId, eventId]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex min-w-0 items-center gap-2">
                <Link
                    href={backHref}
                    aria-label={t("issue.back")}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                {event ? (
                    <h2 className="min-w-0 flex-1 truncate text-base font-semibold" title={event.message}>
                        {event.message}
                    </h2>
                ) : (
                    <Skeleton className="h-5 w-64 max-w-full" />
                )}
                {issueId && (
                    <Link href={issueHref(issueId)} className="shrink-0 text-xs text-primary hover:underline">
                        {t("events.openIssue")}
                    </Link>
                )}
            </div>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            {event ? <EventPanel event={event} kept={1} /> : !error && <Skeleton className="h-64 w-full" />}
        </div>
    );
}

/** The releases a project's events name, each a way into its issues. */
interface TagRow {
    readonly value: string;
    readonly events: number;
    readonly lastSeen: string;
}

/** The rows of either list, in one shape. */
async function readTags(kind: "release" | "environment", projectId: string): Promise<{ rows: TagRow[]; error?: string }> {
    if (kind === "environment") {
        const result = await polls.telemetryEnvironments({ projectId });
        return {
            error: result?.error,
            rows: (result?.environments ?? []).map((row) => ({ ...row, value: row.environment }))
        };
    }
    const result = await polls.telemetryReleases({ projectId });
    return { error: result?.error, rows: (result?.releases ?? []).map((row) => ({ ...row, value: row.release })) };
}

/** The releases a project's events name, or with `kind` its environments: each
 *  one a way into the issues seen there. */
export function ReleaseList({
    projectId,
    issuesHref,
    kind = "release"
}: {
    projectId: string;
    issuesHref: (value: string) => string;
    kind?: "release" | "environment";
}) {
    const t = useTranslations("telemetry");
    const [rows, setRows] = useState<readonly TagRow[] | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let live = true;
        setRows(null);
        void runAction(() => readTags(kind, projectId), setError).then((result) => {
            if (!live || !result) return;
            if (result.error) setError(result.error);
            setRows(result.rows);
        });
        return () => {
            live = false;
        };
    }, [projectId, kind]);
    const Icon = kind === "environment" ? Layers : Tag;

    if (rows === null) {
        return (
            <div className="flex flex-col gap-2" aria-busy="true">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </div>
        );
    }
    if (rows.length === 0) {
        return (
            <>
                {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                {kind === "environment" ? (
                    <EmptyState
                        icon={<Layers />}
                        title={t("environments.none")}
                        description={t("environments.noneHint")}
                    />
                ) : (
                    <EmptyState icon={<Tag />} title={t("releases.none")} description={t("releases.noneHint")} />
                )}
            </>
        );
    }
    return (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {rows.map((row) => (
                <li key={row.value}>
                    <Link
                        href={issuesHref(row.value)}
                        className="flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted"
                    >
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-sm" title={row.value}>
                            {row.value}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {t("releases.events", { count: row.events })}
                        </span>
                        <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:block">
                            <RelativeTime iso={row.lastSeen} />
                        </span>
                    </Link>
                </li>
            ))}
        </ul>
    );
}
