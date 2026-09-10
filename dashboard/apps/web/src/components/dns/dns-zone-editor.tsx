"use client";

/**
 * A zone's DNS records, edited in place, and whether each one has reached the
 * public resolvers yet.
 *
 * The records are a table (`DnsRecordsTable`) narrowed by type and a search, and
 * they are kept in the tab: coming back to a zone paints the records it showed
 * last before the read behind them leaves, and the read only moves what changed.
 * Its header, filters and the table's own chrome never wait on that read - only
 * the rows do, as skeleton rows.
 *
 * Every write is shown before Cloudflare answers. An added or changed record is
 * in the table at once, dimmed until it is stored; a deleted one is gone at once.
 * A refusal puts the table back as it was - and for an add or an edit, reopens
 * the form with what was typed and the reason - and every success reads the zone
 * again, so what is on screen ends up being what Cloudflare holds.
 *
 * Used for a zone an administrator reaches through this Polaris's Cloudflare
 * token and for a domain somebody brought with a token of its own; the actions
 * decide which records each may see and touch.
 */

import * as view from "@/lib/dns/records-view";
import { DnsRecordsTable } from "./dns-records-table";
import { Plus, RefreshCw, Search } from "lucide-react";
import { PropagationPanel } from "./dns-propagation-panel";
import { useLiveRead } from "@/components/use-live-resource";
import type { DnsRecordView, ZoneRecords } from "@/lib/dns/zone-records";
import { Button, ConfirmDeleteDialog, Input, Select } from "@polaris/ui";
import { DnsRecordDialog, type RecordEditing } from "./dns-record-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emptyDraft, normalizeDraft, type DnsRecordDraft, type DnsRecordFields } from "@/lib/dns/record-schema";
import {
    deleteDnsRecordAction,
    saveDnsRecordAction,
    zoneRecordsAction,
    type DnsScopeRef
} from "@/app/(app)/account/domains/dns-actions";

/** Ids for rows added before Cloudflare has given them one. */
let pendingSequence = 0;

/**
 * `scope` is the zone to edit, or null while the page is still finding out which:
 * the header, the filters and the table's chrome are drawn either way, with the
 * rows pulsing until there are rows to draw.
 */
export function DnsZoneEditor({ scope }: { scope: DnsScopeRef | null }) {
    const key = scope ? JSON.stringify(scope) : "";
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    const load = useCallback(async (): Promise<ZoneRecords> => {
        if (!scopeRef.current) throw new Error("No zone is picked");
        const result = await zoneRecordsAction(scopeRef.current).catch(() => ({
            zone: undefined,
            error: "Could not read the records"
        }));
        if (!result.zone) throw new Error(result.error ?? "Could not read the records");
        return result.zone;
        // The scope is read through the ref; its key is what makes it a new subject.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const live = useLiveRead<ZoneRecords>({ load, cacheKey: `dns.records.${key}`, enabled: scope !== null });

    // The kept copy is painted from the first effect rather than the first render:
    // this is rendered on the server too, where the tab's copy does not exist, and
    // the browser must hydrate the same rows the HTML has.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const zone = mounted ? live.data : null;

    const [filters, setFilters] = useState<view.RecordFilters>(view.NO_RECORD_FILTERS);
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [editing, setEditing] = useState<RecordEditing | null>(null);
    const [deleting, setDeleting] = useState<DnsRecordView | null>(null);
    const [checking, setChecking] = useState<string | null>(null);
    const [error, setError] = useState("");

    // The zone as it is now, for writes that land after other writes have moved it.
    const zoneRef = useRef(live.data);
    zoneRef.current = live.data;
    const update = useCallback(
        (change: (current: ZoneRecords) => ZoneRecords) => {
            if (!zoneRef.current) return;
            zoneRef.current = change(zoneRef.current);
            live.replace(zoneRef.current);
        },
        [live]
    );
    const mark = (id: string, busy: boolean) =>
        setPending((current) => {
            const next = new Set(current);
            if (busy) next.add(id);
            else next.delete(id);
            return next;
        });

    const all = zone?.records ?? null;
    const shown = useMemo(() => (all ? view.listedRecords(all, filters) : null), [all, filters]);
    const types = useMemo(() => view.recordTypesIn(all ?? []), [all]);
    const narrowed = filters.type !== view.ALL_TYPES || filters.search.trim() !== "";

    function openEditor(record: DnsRecordView | null) {
        const draft = record?.draft ?? emptyDraft("A");
        setEditing({ id: record?.id ?? null, draft, original: JSON.stringify(normalizeDraft(draft)) });
    }

    /** Put the record in the table, send it, and settle the row on the answer. */
    function submit(opened: RecordEditing, draft: DnsRecordDraft, fields: DnsRecordFields) {
        const current = zoneRef.current;
        if (!current || !scope) return;
        const original = current.records.find((record) => record.id === opened.id) ?? null;
        const id = opened.id ?? `pending-${(pendingSequence += 1)}`;
        const optimistic = view.pendingView(id, fields, draft, current.zone.name);
        setEditing(null);
        setError("");
        update((zone) => ({
            ...zone,
            records: original
                ? zone.records.map((record) => (record.id === id ? optimistic : record))
                : [...zone.records, optimistic]
        }));
        mark(id, true);
        void saveDnsRecordAction(scope, opened.id, draft)
            .catch(() => ({ record: undefined, error: "Could not save the record", problems: undefined }))
            .then((result) => {
                mark(id, false);
                const saved = result.record;
                if (saved) {
                    update((zone) => ({ ...zone, records: zone.records.map((record) => (record.id === id ? saved : record)) }));
                    live.refresh();
                    return;
                }
                update((zone) => ({
                    ...zone,
                    records: original
                        ? zone.records.map((record) => (record.id === id ? original : record))
                        : zone.records.filter((record) => record.id !== id)
                }));
                setEditing({
                    ...opened,
                    draft,
                    error: result.error ?? "Could not save the record",
                    problems: result.problems
                });
            });
    }

    /** Take the record off the table, delete it, and put it back if that is refused. */
    function remove(record: DnsRecordView) {
        setDeleting(null);
        if (!scope) return;
        setError("");
        if (checking === record.id) setChecking(null);
        update((zone) => ({ ...zone, records: zone.records.filter((entry) => entry.id !== record.id) }));
        void deleteDnsRecordAction(scope, record.id)
            .catch(() => ({ error: "Could not delete the record" }))
            .then((result) => {
                if (!result.error) {
                    live.refresh();
                    return;
                }
                update((zone) =>
                    zone.records.some((entry) => entry.id === record.id)
                        ? zone
                        : { ...zone, records: [...zone.records, record] }
                );
                setError(result.error);
            });
    }

    const problem = error || live.error || live.stale;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        value={filters.search}
                        onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                        placeholder="Search by name or content"
                        aria-label="Search records"
                        autoComplete="off"
                    />
                </div>
                <Select
                    className="sm:w-40"
                    aria-label="Filter by type"
                    value={filters.type}
                    onValueChange={(type) => setFilters((current) => ({ ...current, type }))}
                    options={[
                        { value: view.ALL_TYPES, label: "All types" },
                        ...types.map((type) => ({ value: type, label: type }))
                    ]}
                />
                <div className="flex items-center gap-2">
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={live.refresh}
                        disabled={live.refreshing || !scope}
                        aria-label="Reload records"
                        title="Reload"
                    >
                        <RefreshCw className={live.refreshing ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                    <Button onClick={() => openEditor(null)} disabled={!zone} className="flex-1 sm:flex-none">
                        <Plus className="size-4" /> Add record
                    </Button>
                </div>
            </div>

            {problem ? (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {problem}
                </p>
            ) : null}

            <p className="text-xs text-muted-foreground" aria-live="polite">
                {!zone || !shown
                    ? "Reading the records..."
                    : narrowed
                      ? `Showing ${shown.length} of ${zone.records.length} records`
                      : `${zone.records.length} record${zone.records.length === 1 ? "" : "s"}`}
                {zone?.within ? ` at and under ${zone.within}, in the ${zone.zone.name} zone.` : null}
            </p>

            <DnsRecordsTable
                records={shown ?? (live.error ? [] : null)}
                pending={pending}
                checking={checking}
                expanded={checking && scope ? <PropagationPanel scope={scope} recordId={checking} /> : null}
                empty={
                    !zone ? (
                        "The records could not be read."
                    ) : narrowed ? (
                        <span className="flex flex-col items-center gap-2">
                            No record matches that.
                            <Button size="sm" variant="ghost" onClick={() => setFilters(view.NO_RECORD_FILTERS)}>
                                Clear filters
                            </Button>
                        </span>
                    ) : (
                        <span className="flex flex-col items-center gap-2">
                            No records yet.
                            <Button size="sm" variant="secondary" onClick={() => openEditor(null)}>
                                <Plus className="size-4" /> Add record
                            </Button>
                        </span>
                    )
                }
                onCheck={(record) => setChecking((current) => (current === record.id ? null : record.id))}
                onEdit={openEditor}
                onDelete={setDeleting}
            />

            {zone && editing && (
                <DnsRecordDialog
                    zone={zone}
                    editing={editing}
                    onClose={() => setEditing(null)}
                    onSubmit={(draft, fields) => submit(editing, draft, fields)}
                />
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                kind="record"
                title="Delete DNS record"
                name={deleting ? `${deleting.type} ${deleting.name}` : ""}
                requireTyping={false}
                question={
                    deleting ? (
                        <>
                            Delete the <span className="font-medium text-foreground">{deleting.type}</span> record{" "}
                            <span className="font-medium text-foreground">{deleting.name}</span>
                            {deleting.content ? (
                                <>
                                    {" "}
                                    with content{" "}
                                    <code className="break-all font-mono text-xs text-foreground">{deleting.content}</code>
                                </>
                            ) : null}
                            ?
                        </>
                    ) : null
                }
                description="Resolvers keep answering with it until their cached copy expires."
                confirmLabel="Delete record"
                onConfirm={() => deleting && remove(deleting)}
            />
        </div>
    );
}
