"use client";

/**
 * What happened to a record, newest first: who made it, each field changed
 * from what to what, a trip to the trash and back. The newest page comes with
 * the record; older ones are read on request.
 */

import { useCrmT } from "./i18n";
import { useState } from "react";
import { Button } from "@polaris/ui";
import { messageOf, unwrap } from "./call";
import { CellDisplay } from "./cell-display";
import { fieldLabel } from "./custom-fields";
import * as actions from "../actions/records";
import { hostUi } from "@polaris/app-host/client";
import { ArrowRight, History } from "lucide-react";
import type { CrmObject, FieldDef } from "../model/objects";
import type { TimelineEvent, TimelinePage } from "../model/timeline";

export interface TimelineProps {
    readonly object: CrmObject;
    readonly id: string;
    readonly page: TimelinePage | null;
    /** Every field of the record, to name and draw a change; a change to a
     *  field that is gone is left out. */
    readonly fields: readonly FieldDef[];
}

export function Timeline({ object, id, page, fields }: TimelineProps) {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [older, setOlder] = useState<{
        from: TimelinePage;
        events: TimelineEvent[];
        next: string | null;
    } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Older pages belong to the newest page they were read after.
    const extra = older && older.from === page ? older : null;
    const events = [...(page?.events ?? []), ...(extra?.events ?? [])];
    const next = extra ? extra.next : (page?.next ?? null);
    const byKey = new Map(fields.map((field) => [field.key, field]));

    const loadMore = () => {
        if (!next || !page || loading) return;
        setLoading(true);
        setError(null);
        unwrap(
            () => actions.recordTimelineAction({ object, id, before: next }),
            t("errors.loadFailed")
        )
            .then((more) =>
                setOlder({
                    from: page,
                    events: [...(extra?.events ?? []), ...more.events],
                    next: more.next
                })
            )
            .catch((caught) => setError(messageOf(caught)))
            .finally(() => setLoading(false));
    };

    const line = (event: TimelineEvent) => {
        const actor = event.actor?.name || t("timeline.someone");
        const changes = event.changes.filter((change) => byKey.has(change.key));
        return (
            <li key={event.id} className="flex min-w-0 flex-col gap-1 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                    <span className="min-w-0 text-[0.8125rem]">
                        {t(`timeline.${event.kind}`, { actor })}
                    </span>
                    <time
                        dateTime={event.at}
                        className="shrink-0 text-[0.75rem] tabular-nums text-muted-foreground"
                    >
                        {format.dateTime(event.at)}
                    </time>
                </div>
                {changes.length > 0 ? (
                    <ul className="flex min-w-0 flex-col gap-1">
                        {changes.map((change) => {
                            const field = byKey.get(change.key)!;
                            return (
                                <li
                                    key={change.key}
                                    className="grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-2 text-[0.75rem]"
                                >
                                    <span
                                        className="truncate text-muted-foreground"
                                        title={fieldLabel(t, object, field)}
                                    >
                                        {fieldLabel(t, object, field)}
                                    </span>
                                    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                                        {event.kind === "updated" ? (
                                            <>
                                                <span className="flex min-w-0 items-center overflow-hidden text-muted-foreground line-through">
                                                    <CellDisplay
                                                        object={object}
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
                                                object={object}
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

    return (
        <section
            aria-label={t("timeline.title")}
            className="min-w-0 rounded-lg border border-border bg-card"
        >
            <h2 className="flex items-center gap-2 border-b border-border px-3 py-2 text-[0.8125rem] font-medium">
                <History className="size-3.5 text-muted-foreground" />
                {t("timeline.title")}
            </h2>
            {page === null ? (
                <div className="flex flex-col gap-2 p-3" aria-hidden>
                    <span className="block h-3 w-2/3 animate-pulse rounded bg-muted" />
                    <span className="block h-3 w-1/2 animate-pulse rounded bg-muted" />
                </div>
            ) : events.length === 0 ? (
                <p className="px-3 py-3 text-[0.8125rem] text-muted-foreground">
                    {t("timeline.empty")}
                </p>
            ) : (
                <ol className="flex flex-col divide-y divide-border">{events.map(line)}</ol>
            )}
            {error ? (
                <p role="alert" className="px-3 pb-2 text-[0.75rem] text-destructive">
                    {error}
                </p>
            ) : null}
            {next ? (
                <div className="border-t border-border p-2">
                    <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
                        {t("timeline.more")}
                    </Button>
                </div>
            ) : null}
        </section>
    );
}
