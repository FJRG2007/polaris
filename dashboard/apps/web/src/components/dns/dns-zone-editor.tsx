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
 * the form with what was typed and the reason, or says so above the table when
 * another form is open by then - and every write, stored or refused, reads the
 * zone again, so what is on screen ends up being what Cloudflare holds.
 *
 * Used for a zone an administrator reaches through this Polaris's Cloudflare
 * token and for a domain somebody brought with a token of its own; the actions
 * decide which records each may see and touch.
 */

import * as view from "@/lib/dns/records-view";
import { DnsRecordsTable, useOwnerText } from "./dns-records-table";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import { PropagationPanel } from "./dns-propagation-panel";
import { useLiveRead } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DnsRecordView, ZoneRecords } from "@/lib/dns/zone-records";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import { DnsRecordDialog, type RecordEditing } from "./dns-record-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { emptyDraft, normalizeDraft, type DnsRecordDraft, type DnsRecordFields } from "@/lib/dns/record-schema";
import {
    deleteDnsRecordAction,
    saveDnsRecordAction,
    zoneRecordsAction,
    type DnsScopeRef
} from "@/app/(app)/account/domains/dns-actions";

/** Ids for rows added before Cloudflare has given them one. */
let pendingSequence = 0;

/** One number per opened form, so a form opened again starts from what it is given. */
let sessionSequence = 0;

type EditorSession = RecordEditing & { readonly session: number };

/**
 * `scope` is the zone to edit, or null while the page is still finding out which:
 * the header, the filters and the table's chrome are drawn either way, with the
 * rows pulsing until there are rows to draw.
 */
export function DnsZoneEditor({ scope }: { scope: DnsScopeRef | null }) {
    const t = useTranslations("dns");
    const key = scope ? JSON.stringify(scope) : "";
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    const load = useCallback(async (): Promise<ZoneRecords> => {
        if (!scopeRef.current) throw new Error("No zone is picked");
        const result = await zoneRecordsAction(scopeRef.current).catch(() => ({
            zone: undefined,
            error: t("editor.readFailed")
        }));
        if (!result.zone) throw new Error(result.error ?? t("editor.readFailed"));
        return result.zone;
        // The scope is read through the ref; its key is what makes it a new subject.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, t]);
    const live = useLiveRead<ZoneRecords>({ load, cacheKey: `dns.records.${key}`, enabled: scope !== null });

    // The kept copy is painted from the first effect rather than the first render:
    // this is rendered on the server too, where the tab's copy does not exist, and
    // the browser must hydrate the same rows the HTML has.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    const zone = mounted ? live.data : null;

    const [filters, setFilters] = useState<view.RecordFilters>(view.NO_RECORD_FILTERS);
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [editing, setEditing] = useState<EditorSession | null>(null);
    const [refused, setRefused] = useState<{ editing: RecordEditing; message: string } | null>(null);
    const [deleting, setDeleting] = useState<DnsRecordView | null>(null);
    // A record Polaris manages, held here until its edit is confirmed.
    const [guarded, setGuarded] = useState<DnsRecordView | null>(null);
    const ownerText = useOwnerText();
    const [checking, setChecking] = useState<string | null>(null);
    const [error, setError] = useState("");
    const editingRef = useRef(editing);
    editingRef.current = editing;

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
    const narrowed = view.isNarrowed(filters);
    const breaks = (record: DnsRecordView) =>
        record.owner ? t(`owner.breaks.${view.OWNER_KEYS[record.owner.kind]}`) : "";

    function openForm(next: RecordEditing) {
        setEditing({ ...next, session: (sessionSequence += 1) });
    }

    /** Open the form - for a record Polaris manages, only once the warning is confirmed. */
    function openEditor(record: DnsRecordView | null, confirmed = false) {
        if (record?.owner && !confirmed) {
            setGuarded(record);
            return;
        }
        const draft = record?.draft ?? emptyDraft("A");
        openForm({ id: record?.id ?? null, draft, original: JSON.stringify(normalizeDraft(draft)) });
    }

    function reopenRefused() {
        if (!refused) return;
        openForm(refused.editing);
        setRefused(null);
    }

    /** Put the record in the table, send it, and settle the row on the answer. */
    function submit(opened: RecordEditing, draft: DnsRecordDraft, fields: DnsRecordFields) {
        const current = zoneRef.current;
        if (!current || !scope) return;
        const original = current.records.find((record) => record.id === opened.id) ?? null;
        const id = opened.id ?? `pending-${(pendingSequence += 1)}`;
        const optimistic = { ...view.pendingView(id, fields, draft, current.zone.name), owner: original?.owner };
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
            .catch(() => ({ record: undefined, error: t("editor.saveFailed"), problems: undefined }))
            .then((result) => {
                mark(id, false);
                const saved = result.record;
                if (saved) {
                    const kept = { ...saved, owner: saved.owner ?? original?.owner };
                    update((zone) => ({ ...zone, records: zone.records.map((record) => (record.id === id ? kept : record)) }));
                    live.refresh();
                    return;
                }
                update((zone) => ({
                    ...zone,
                    records: original
                        ? zone.records.map((record) => (record.id === id ? original : record))
                        : zone.records.filter((record) => record.id !== id)
                }));
                live.refresh();
                const refusal = {
                    ...opened,
                    draft,
                    error: result.error ?? t("editor.saveFailed"),
                    problems: result.problems
                };
                if (!editingRef.current) {
                    openForm(refusal);
                    return;
                }
                const reason = Object.values(result.problems ?? {})[0] ?? refusal.error;
                setRefused({
                    editing: refusal,
                    message: t("editor.notSaved", { type: fields.type, name: optimistic.relative, reason })
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
            .catch(() => ({ error: t("editor.deleteFailed") }))
            .then((result) => {
                if (result.error) {
                    update((zone) =>
                        zone.records.some((entry) => entry.id === record.id)
                            ? zone
                            : { ...zone, records: [...zone.records, record] }
                    );
                    setError(result.error);
                }
                live.refresh();
            });
    }

    const problem = error || live.error || live.stale;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="ps-9"
                        value={filters.search}
                        onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                        placeholder={t("editor.searchPlaceholder")}
                        aria-label={t("editor.searchAria")}
                        autoComplete="off"
                    />
                </div>
                <Select
                    className="sm:w-40"
                    aria-label={t("editor.filterAria")}
                    value={filters.type}
                    onValueChange={(type) => setFilters((current) => ({ ...current, type }))}
                    options={[
                        { value: view.ALL_TYPES, label: t("editor.allTypes") },
                        ...types.map((type) => ({ value: type, label: type }))
                    ]}
                />
                <Select
                    className="sm:w-48"
                    aria-label={t("owner.filterAria")}
                    value={filters.owned}
                    onValueChange={(owned) => setFilters((current) => ({ ...current, owned: owned as view.OwnedFilter }))}
                    options={[
                        { value: "all", label: t("owner.all") },
                        { value: "polaris", label: t("owner.managed") },
                        { value: "other", label: t("owner.unmanaged") }
                    ]}
                />
                <div className="flex items-center gap-2">
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={live.refresh}
                        disabled={live.refreshing || !scope}
                        aria-label={t("editor.reloadAria")}
                        title={t("editor.reload")}
                    >
                        <RefreshCw className={live.refreshing ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                    <Button onClick={() => openEditor(null)} disabled={!zone} className="flex-1 sm:flex-none">
                        <Plus className="size-4" /> {t("editor.add")}
                    </Button>
                </div>
            </div>

            {problem ? (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {problem}
                </p>
            ) : null}

            {refused ? (
                <div
                    role="alert"
                    className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
                    <span className="min-w-0 flex-1">{refused.message}</span>
                    <Button size="sm" variant="ghost" onClick={reopenRefused}>
                        {t("editor.editAgain")}
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setRefused(null)}
                        aria-label={t("editor.dismiss")}
                        title={t("editor.dismiss")}
                    >
                        <X className="size-4" />
                    </Button>
                </div>
            ) : null}

            <p className="text-xs text-muted-foreground" aria-live="polite">
                {!zone || !shown
                    ? t("editor.reading")
                    : narrowed
                      ? zone.within
                          ? t("editor.showingWithin", {
                                shown: shown.length,
                                total: zone.records.length,
                                domain: zone.within,
                                zone: zone.zone.name
                            })
                          : t("editor.showing", { shown: shown.length, total: zone.records.length })
                      : zone.within
                        ? t("editor.countWithin", { count: zone.records.length, domain: zone.within, zone: zone.zone.name })
                        : t("editor.count", { count: zone.records.length })}
            </p>

            <DnsRecordsTable
                records={shown ?? (live.error ? [] : null)}
                pending={pending}
                checking={checking}
                expanded={checking && scope ? <PropagationPanel scope={scope} recordId={checking} /> : null}
                empty={
                    !zone ? (
                        t("editor.unreadable")
                    ) : narrowed ? (
                        <span className="flex flex-col items-center gap-2">
                            {t("editor.noMatch")}
                            <Button size="sm" variant="ghost" onClick={() => setFilters(view.NO_RECORD_FILTERS)}>
                                {t("editor.clearFilters")}
                            </Button>
                        </span>
                    ) : (
                        <span className="flex flex-col items-center gap-2">
                            {t("editor.empty")}
                            <Button size="sm" variant="secondary" onClick={() => openEditor(null)}>
                                <Plus className="size-4" /> {t("editor.add")}
                            </Button>
                        </span>
                    )
                }
                onCheck={(record) => setChecking((current) => (current === record.id ? null : record.id))}
                onEdit={(record) => openEditor(record)}
                onDelete={setDeleting}
            />

            {zone && editing && (
                <DnsRecordDialog
                    key={editing.session}
                    zone={zone}
                    editing={editing}
                    onClose={() => setEditing(null)}
                    onSubmit={(draft, fields) => submit(editing, draft, fields)}
                />
            )}

            <Dialog open={guarded !== null} onOpenChange={(open) => !open && setGuarded(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("owner.editTitle")}</DialogTitle>
                        <DialogDescription>
                            {guarded?.owner
                                ? t("owner.editQuestion", {
                                      type: guarded.type,
                                      name: guarded.relative,
                                      what: ownerText(guarded.owner)
                                  })
                                : null}
                        </DialogDescription>
                    </DialogHeader>
                    <p className="mt-3 text-sm text-danger-ink">{guarded ? breaks(guarded) : null}</p>
                    <DialogFooter className="mt-4">
                        <Button variant="ghost" onClick={() => setGuarded(null)}>
                            {t("owner.cancel")}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => {
                                const record = guarded;
                                setGuarded(null);
                                if (record) openEditor(record, true);
                            }}
                        >
                            {t("owner.editConfirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                kind="record"
                title={t("editor.deleteTitle")}
                name={deleting ? `${deleting.type} ${deleting.name}` : ""}
                requireTyping={false}
                question={
                    deleting ? (
                        <>
                            {t.rich<ReactNode>(deleting.content ? "editor.deleteQuestionContent" : "editor.deleteQuestion", {
                                type: deleting.type,
                                name: deleting.name,
                                content: deleting.content,
                                strong: (chunks) => (
                                    <span key={String(chunks)} className="font-medium text-foreground">
                                        {chunks}
                                    </span>
                                ),
                                code: (chunks) => (
                                    <code key="content" className="break-all font-mono text-xs text-foreground">
                                        {chunks}
                                    </code>
                                )
                            })}
                        </>
                    ) : null
                }
                description={
                    deleting?.owner ? (
                        <span className="flex flex-col gap-1.5">
                            <span role="alert" className="font-medium text-danger-ink">
                                {t("owner.deleteWarning", { what: ownerText(deleting.owner), breaks: breaks(deleting) })}
                            </span>
                            <span>{t("editor.deleteDescription")}</span>
                        </span>
                    ) : (
                        t("editor.deleteDescription")
                    )
                }
                confirmLabel={t("editor.deleteConfirm")}
                onConfirm={() => deleting && remove(deleting)}
            />
        </div>
    );
}
