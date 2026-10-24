"use client";

/**
 * The CRM's audit log: every change to every record the reader may follow,
 * newest first, narrowed by kind of record, what happened, who did it and
 * which days, and downloadable as a CSV file as narrowed.
 *
 * The header and the filters paint at once; the events fill in when they
 * arrive, from what this tab kept last time first.
 */

import Link from "next/link";
import { useCrmT } from "./i18n";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/audit";
import { CellDisplay } from "./cell-display";
import { fieldLabel } from "./custom-fields";
import { useCallback, useState } from "react";
import { recordHref } from "../model/related";
import { hostUi } from "@polaris/app-host/client";
import type { AuditReading } from "../actions/audit";
import { ArrowRight, Download, History } from "lucide-react";
import { EVENT_KINDS, type EventKind } from "../model/timeline";
import { CRM_OBJECTS, fieldsOf, type CrmObject } from "../model/objects";
import { Button, EmptyState, Select, useToast, DateInput } from "@polaris/ui";
import { auditRange, type AuditEvent, type AuditQuery } from "../model/audit";

const ALL = "all";

interface Filters {
    readonly object: CrmObject | null;
    readonly kind: EventKind | null;
    readonly actorId: string | null;
    /** Days as the date inputs hold them, "2026-10-13", or empty. */
    readonly from: string;
    readonly to: string;
}

const NO_FILTERS: Filters = { object: null, kind: null, actorId: null, from: "", to: "" };

function toQuery(filters: Filters): AuditQuery {
    return {
        object: filters.object,
        kind: filters.kind,
        actorId: filters.actorId,
        ...auditRange(filters.from, filters.to),
        cursor: null
    };
}

function Block({ className }: { className: string }) {
    return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

export function AuditScreen() {
    const t = useCrmT();
    const toast = useToast();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);
    const query = toQuery(filters);
    const key = JSON.stringify(query);
    const load = useCallback(
        () => unwrap(() => actions.auditAction(JSON.parse(key)), t("errors.loadFailed")),
        [key, t]
    );
    const reading = hostUi.liveRead.useLiveRead<AuditReading>({
        cacheKey: `crm:audit:${key}`,
        load
    });
    const data = reading.data ?? null;

    // Older pages belong to the newest page they were read after.
    const [older, setOlder] = useState<{
        from: AuditReading;
        events: AuditEvent[];
        next: string | null;
    } | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [moreError, setMoreError] = useState<string | null>(null);
    const extra = older && older.from === data ? older : null;
    const events = [...(data?.events ?? []), ...(extra?.events ?? [])];
    const next = extra ? extra.next : (data?.next ?? null);

    const loadMore = () => {
        if (!next || !data || loadingMore) return;
        setLoadingMore(true);
        setMoreError(null);
        unwrap(() => actions.auditAction({ ...query, cursor: next }), t("errors.loadFailed"))
            .then((more) =>
                setOlder({
                    from: data,
                    events: [...(extra?.events ?? []), ...more.events],
                    next: more.next
                })
            )
            .catch((caught) => setMoreError(messageOf(caught)))
            .finally(() => setLoadingMore(false));
    };

    const [exporting, setExporting] = useState(false);
    const exportCsv = async () => {
        setExporting(true);
        try {
            const file = await unwrap(
                () => actions.exportAuditAction(query),
                t("audit.exportFailed")
            );
            const url = URL.createObjectURL(new Blob([file.csv], { type: "text/csv" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast.show({
                title: file.truncated
                    ? t("audit.truncated", { count: file.rows })
                    : t("audit.exported", { count: file.rows })
            });
        } catch (caught) {
            toast.show({ title: t("audit.exportFailed"), body: messageOf(caught) });
        } finally {
            setExporting(false);
        }
    };

    const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
    const set = (change: Partial<Filters>) => setFilters((current) => ({ ...current, ...change }));
    const objects = data?.objects ?? CRM_OBJECTS;

    const line = (event: AuditEvent) => {
        const fields = new Map(
            fieldsOf(event.object, data?.fields[event.object] ?? []).map((field) => [
                field.key,
                field
            ])
        );
        const changes = event.changes.filter((change) => fields.has(change.key));
        return (
            <li key={event.id} className="flex min-w-0 flex-col gap-1 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="shrink-0 text-[0.8125rem] font-medium">
                        {t(`audit.kinds.${event.kind}`)}
                    </span>
                    {event.recordName !== null ? (
                        <Link
                            href={recordHref(event.object, event.recordId)}
                            className="min-w-0 truncate text-[0.8125rem] underline-offset-2 hover:underline"
                            title={event.recordName}
                        >
                            {event.recordName || "-"}
                        </Link>
                    ) : (
                        <span className="min-w-0 truncate text-[0.8125rem] text-muted-foreground">
                            {t("audit.deleted")}
                        </span>
                    )}
                    <span className="shrink-0 text-[0.75rem] text-muted-foreground">
                        {t(`objects.${event.object}.plural`)}
                    </span>
                    <span className="ml-auto flex min-w-0 items-baseline gap-2 text-[0.75rem] text-muted-foreground">
                        <span
                            className="min-w-0 truncate"
                            title={event.actor?.name || t("audit.someone")}
                        >
                            {event.actor?.name || t("audit.someone")}
                        </span>
                        <time dateTime={event.at} className="shrink-0 tabular-nums">
                            {format.dateTime(event.at)}
                        </time>
                    </span>
                </div>
                {changes.length > 0 ? (
                    <ul className="flex min-w-0 flex-col gap-1">
                        {changes.map((change) => {
                            const field = fields.get(change.key)!;
                            const label = fieldLabel(t, event.object, field);
                            return (
                                <li
                                    key={change.key}
                                    className="grid min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-2 text-[0.75rem]"
                                >
                                    <span className="truncate text-muted-foreground" title={label}>
                                        {label}
                                    </span>
                                    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                                        {event.kind === "updated" ? (
                                            <>
                                                <span className="flex min-w-0 items-center overflow-hidden text-muted-foreground line-through">
                                                    <CellDisplay
                                                        object={event.object}
                                                        field={field}
                                                        value={change.before}
                                                    />
                                                </span>
                                                <ArrowRight
                                                    aria-label={t("timeline.to")}
                                                    className="size-3 shrink-0 text-muted-foreground"
                                                />
                                            </>
                                        ) : null}
                                        <span className="flex min-w-0 items-center overflow-hidden">
                                            <CellDisplay
                                                object={event.object}
                                                field={field}
                                                value={change.after}
                                            />
                                        </span>
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                ) : null}
            </li>
        );
    };

    let body;
    if (reading.error && !data) {
        body = (
            <EmptyState
                icon={<History />}
                title={t("errors.loadFailed")}
                description={reading.error}
            />
        );
    } else if (!data) {
        body = (
            <div
                className="flex flex-col divide-y divide-border rounded-lg border border-border"
                aria-busy
            >
                {[0, 1, 2, 3, 4, 5].map((row) => (
                    <div key={row} className="flex flex-col gap-2 px-3 py-3">
                        <Block className="h-3 w-1/2" />
                        <Block className="h-3 w-1/3" />
                    </div>
                ))}
            </div>
        );
    } else if (data.objects.length === 0) {
        body = (
            <EmptyState
                icon={<History />}
                title={t("audit.title")}
                description={t("audit.noAccess")}
            />
        );
    } else if (events.length === 0) {
        body = (
            <EmptyState
                icon={<History />}
                title={filtered ? t("audit.emptyFiltered") : t("audit.empty")}
            />
        );
    } else {
        body = (
            <section
                aria-label={t("audit.title")}
                className="min-w-0 rounded-lg border border-border bg-card"
            >
                <ol className="flex flex-col divide-y divide-border">{events.map(line)}</ol>
                {moreError ? (
                    <p role="alert" className="px-3 pb-2 text-[0.75rem] text-destructive">
                        {moreError}
                    </p>
                ) : null}
                {next ? (
                    <div className="border-t border-border p-2">
                        <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
                            {t("audit.more")}
                        </Button>
                    </div>
                ) : null}
            </section>
        );
    }

    return (
        <div
            className="flex h-full min-h-0 flex-col gap-3 overflow-auto overscroll-contain"
            data-crm-ready
        >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="mr-auto text-[1.0625rem] font-semibold leading-tight tracking-tight">
                    {t("audit.title")}
                </h1>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={exportCsv}
                    disabled={exporting || !data || data.objects.length === 0}
                >
                    <Download className="size-3.5" />
                    {t("audit.export")}
                </Button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Select
                    aria-label={t("audit.object")}
                    value={filters.object ?? ALL}
                    onValueChange={(value) =>
                        set({ object: value === ALL ? null : (value as CrmObject) })
                    }
                    options={[
                        { value: ALL, label: t("audit.allObjects") },
                        ...objects.map((object) => ({
                            value: object,
                            label: t(`objects.${object}.plural`)
                        }))
                    ]}
                />
                <Select
                    aria-label={t("audit.what")}
                    value={filters.kind ?? ALL}
                    onValueChange={(value) =>
                        set({ kind: value === ALL ? null : (value as EventKind) })
                    }
                    options={[
                        { value: ALL, label: t("audit.allKinds") },
                        ...EVENT_KINDS.map((kind) => ({
                            value: kind,
                            label: t(`audit.kinds.${kind}`)
                        }))
                    ]}
                />
                <Select
                    aria-label={t("audit.who")}
                    value={filters.actorId ?? ALL}
                    onValueChange={(value) => set({ actorId: value === ALL ? null : value })}
                    options={[
                        { value: ALL, label: t("audit.everyone") },
                        ...(data?.people ?? []).map((person) => ({
                            value: person.id,
                            label: person.name
                        }))
                    ]}
                />
                <label className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                    {t("audit.from")}
                    <DateInput
                        mode="date"
                        className="h-8 w-[9.5rem]"
                        value={filters.from}
                        max={filters.to || undefined}
                        onChange={(event) => set({ from: event.target.value })}
                    />
                </label>
                <label className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                    {t("audit.to")}
                    <DateInput
                        mode="date"
                        className="h-8 w-[9.5rem]"
                        value={filters.to}
                        min={filters.from || undefined}
                        onChange={(event) => set({ to: event.target.value })}
                    />
                </label>
                {filtered ? (
                    <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                        {t("audit.clear")}
                    </Button>
                ) : null}
            </div>
            {body}
        </div>
    );
}
