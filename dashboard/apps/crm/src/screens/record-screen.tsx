"use client";

/**
 * One record on a page of its own: every field, each changed where it is shown,
 * and the records that point at it - a company's people and deals, a person's
 * deals - each one a link to its own page.
 *
 * The header and the field outline paint at once; the last answer kept for this
 * record paints next, and a fresh one replaces it when it lands. A change shows
 * at once and goes back if it is not kept.
 */

import Link from "next/link";
import { useCrmT } from "./i18n";
import { useDuplicateWarning } from "./use-duplicate-warning";
import { Timeline } from "./timeline";
import { RecordActivities } from "./record-activities";
import { CellPicker } from "./cell-picker";
import { editorFor } from "./cell-editors";
import { messageOf, unwrap } from "./call";
import { fieldLabel } from "./custom-fields";
import { RunWorkflowMenu } from "./run-workflow-menu";
import * as actions from "../actions/records";
import { useCallback, useState } from "react";
import { hostUi } from "@polaris/app-host/client";
import type { InputValue } from "../model/values";
import { CellDisplay, RefChip } from "./cell-display";
import { recordHref, recordSubjectId } from "../model/related";
import type { RecordOpening } from "../lib/record-page";

const { ShareDialog } = hostUi.accessShareDialog;
import { useFavorite } from "./use-favorite";
import { ArrowLeft, Link2, Maximize2, RotateCcw, Share2, ShieldOff, Star } from "lucide-react";
import { Badge, Button, cn, DialogTitle, EmptyState, useToast } from "@polaris/ui";
import {
    fieldsOf,
    recordName,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type FieldValue
} from "../model/objects";
import { ruleFields } from "../model/roles";

function Block({ className }: { className?: string }) {
    return <span aria-hidden className={cn("block animate-pulse rounded bg-muted", className)} />;
}

export interface RecordScreenProps {
    readonly object: CrmObject;
    readonly id: string;
    /** Drawn in a side panel over a list rather than on a page of its own. */
    readonly panel?: boolean;
    /** A change kept by the server, so a list behind the panel can show it. */
    readonly onSaved?: (record: CrmRecord) => void;
}

export function RecordScreen({ object, id, panel = false, onSaved }: RecordScreenProps) {
    const t = useCrmT();
    const toast = useToast();
    const warnDuplicates = useDuplicateWarning(object);
    const format = hostUi.displayFormat.useDisplayFormat();
    const load = useCallback(
        () => unwrap(() => actions.openRecordAction({ object, id }), t("errors.loadFailed")),
        [object, id, t]
    );
    const opening = hostUi.liveRead.useLiveRead<RecordOpening>({
        cacheKey: `crm:record:${object}:${id}`,
        load
    });
    const [editing, setEditing] = useState<string | null>(null);
    const [sharing, setSharing] = useState(false);
    const data = opening.data;
    const record = data?.record ?? null;
    const canEdit = Boolean(data?.can[object].edit) && !record?.deletedAt;
    const canRestore = Boolean(data?.can[object].delete) && Boolean(record?.deletedAt);
    const fields = ruleFields(fieldsOf(object, data?.fields ?? []), data?.rule);
    const plural = t(`objects.${object}.plural`);

    const save = (field: FieldDef, stored: InputValue, shown: FieldValue) => {
        if (!data || !record) return;
        const kept = data;
        const put = (next: CrmRecord) => opening.replace({ ...kept, record: next });
        put({ ...record, values: { ...record.values, [field.key]: shown } });
        unwrap(
            () => actions.updateRecordAction({ object, id, values: { [field.key]: stored } }),
            t("errors.generic")
        )
            .then(({ record: saved, duplicates }) => {
                put(saved);
                warnDuplicates(duplicates);
                onSaved?.(saved);
                // The change is on the timeline now.
                opening.refresh();
            })
            .catch((caught) => {
                opening.replace(kept);
                toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
            });
    };

    const restore = () => {
        if (!data || !record) return;
        const kept = data;
        const back = { ...record, deletedAt: null };
        opening.replace({ ...kept, record: back });
        unwrap(() => actions.restoreRecordsAction({ object, ids: [id] }), t("errors.generic"))
            .then(({ count }) => {
                if (count === 0) throw new Error(t("errors.notFound"));
                onSaved?.(back);
                toast.show({ title: t("trashView.restored") });
                opening.refresh();
            })
            .catch((caught) => {
                opening.replace(kept);
                toast.show({ title: t("errors.notSaved"), body: messageOf(caught) });
            });
    };

    const open = (field: FieldDef) => {
        if (!canEdit || field.readOnly || !record) return;
        if (field.kind === "boolean") {
            const next = !record.values[field.key];
            save(field, next, next);
            return;
        }
        setEditing(field.key);
    };

    const favorite = useFavorite(
        "record",
        object,
        record ? id : null,
        Boolean(opening.data?.favorite)
    );

    const copyLink = () => {
        void navigator.clipboard
            ?.writeText(new URL(recordHref(object, id), window.location.origin).toString())
            .then(() => toast.show({ title: t("record.linkCopied") }))
            .catch(() => undefined);
    };

    const name = record ? recordName(object, record) || t("record.untitled") : null;
    const title = (
        <>
            {name}
            {!record && opening.loading ? <Block className="h-5 w-48" /> : null}
        </>
    );
    const titleClass =
        "mr-auto min-w-0 truncate text-[1.0625rem] font-semibold leading-tight tracking-tight";
    const header = (
        <div className={cn("flex min-w-0 flex-wrap items-center gap-2", panel && "pr-10")}>
            {panel ? null : (
                <Button variant="ghost" size="sm" asChild>
                    <Link href={`/crm/${object}`}>
                        <ArrowLeft className="size-4" />
                        <span className="truncate" title={plural}>
                            {plural}
                        </span>
                    </Link>
                </Button>
            )}
            {panel ? (
                <DialogTitle className={titleClass}>{title}</DialogTitle>
            ) : (
                <h1 className={titleClass}>{title}</h1>
            )}
            {panel ? (
                <Button variant="ghost" size="sm" asChild>
                    <Link
                        href={recordHref(object, id)}
                        aria-label={t("record.openPage")}
                        title={t("record.openPage")}
                    >
                        <Maximize2 className="size-4" />
                    </Link>
                </Button>
            ) : null}
            {record && canEdit ? (
                <RunWorkflowMenu object={object} id={id} onRan={opening.refresh} />
            ) : null}
            {data?.shared ? <Badge variant="neutral">{t("record.sharedWithYou")}</Badge> : null}
            {record && canEdit && !data?.shared ? (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSharing(true)}
                    aria-label={t("record.share")}
                    title={t("record.share")}
                >
                    <Share2 className="size-4" />
                </Button>
            ) : null}
            {record && !record.deletedAt && !data?.shared ? (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={favorite.toggle}
                    aria-pressed={favorite.pinned}
                    aria-label={t(favorite.pinned ? "favorites.remove" : "favorites.add")}
                    title={t(favorite.pinned ? "favorites.remove" : "favorites.add")}
                >
                    <Star
                        className={cn("size-4", favorite.pinned && "fill-current text-warning")}
                    />
                </Button>
            ) : null}
            {record ? (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={copyLink}
                    aria-label={t("record.copyLink")}
                    title={t("record.copyLink")}
                >
                    <Link2 className="size-4" />
                </Button>
            ) : null}
            {sharing && record && name ? (
                <ShareDialog
                    open
                    onOpenChange={(next) => {
                        if (!next) setSharing(false);
                    }}
                    subject="crm.record"
                    subjectId={recordSubjectId(object, id)}
                    name={name}
                />
            ) : null}
        </div>
    );

    if (!opening.loading && !record) {
        return (
            <div className="flex h-full min-h-0 flex-col gap-3">
                {header}
                <EmptyState
                    icon={<ShieldOff />}
                    title={opening.error ?? t("errors.notFound")}
                    action={
                        <Button variant="outline" onClick={opening.refresh}>
                            {t("actions.retry")}
                        </Button>
                    }
                />
            </div>
        );
    }

    const row = (field: FieldDef) => {
        const value = record?.values[field.key];
        const active = editing === field.key;
        const close = () => setEditing(null);
        const Editor = active ? editorFor(field) : null;
        const editable = canEdit && !field.readOnly;
        return (
            <div
                key={field.key}
                className="grid min-w-0 grid-cols-1 items-center border-b border-border last:border-b-0 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] sm:gap-3"
            >
                <span
                    className="truncate pl-3 pt-2 text-[0.8125rem] text-muted-foreground sm:py-2"
                    title={fieldLabel(t, object, field)}
                >
                    {fieldLabel(t, object, field)}
                </span>
                <div
                    role={editable ? "button" : undefined}
                    tabIndex={editable ? 0 : -1}
                    aria-label={fieldLabel(t, object, field)}
                    className={cn(
                        "relative flex h-9 min-w-0 items-center overflow-visible rounded px-2.5 text-[0.8125rem]",
                        editable && "cursor-text hover:bg-muted/60"
                    )}
                    onClick={(event) => {
                        if (!event.currentTarget.contains(event.target as Node)) return;
                        if (!active) open(field);
                    }}
                    onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === "F2") {
                            event.preventDefault();
                            open(field);
                        }
                    }}
                >
                    {record ? (
                        <span className="flex min-w-0 items-center overflow-hidden">
                            <CellDisplay object={object} field={field} value={value} />
                        </span>
                    ) : (
                        <Block className="h-3 w-32" />
                    )}
                    {Editor ? (
                        <Editor
                            field={field}
                            value={value}
                            defaultCurrency={format.preferences.currency}
                            onCancel={close}
                            onCommit={(next) => {
                                close();
                                save(field, next, next as FieldValue);
                            }}
                        />
                    ) : null}
                    {active && !Editor ? (
                        <CellPicker
                            object={object}
                            field={field}
                            value={value}
                            people={data?.people ?? []}
                            onClose={close}
                            onPick={(stored, shown) => {
                                close();
                                save(field, stored, shown);
                            }}
                        />
                    ) : null}
                </div>
            </div>
        );
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-3" data-crm-ready>
            {header}
            {record?.deletedAt ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-[0.8125rem]">
                    <p className="min-w-0 flex-1">{t("record.inTrash")}</p>
                    {canRestore ? (
                        <Button variant="outline" size="sm" onClick={restore}>
                            <RotateCcw className="size-4" />
                            {t("trashView.restore")}
                        </Button>
                    ) : null}
                </div>
            ) : null}
            <div
                className={cn(
                    "grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overscroll-contain",
                    !panel && "lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
                )}
            >
                <section
                    aria-label={t("record.fields")}
                    className="h-fit min-w-0 rounded-lg border border-border bg-card"
                >
                    {fields.map(row)}
                </section>
                <div className="flex min-w-0 flex-col gap-3">
                    {(data?.related ?? []).map((list) => (
                        <section
                            key={`${list.object}:${list.field}`}
                            aria-label={list.label ?? t(`objects.${list.object}.plural`)}
                            className="min-w-0 rounded-lg border border-border bg-card"
                        >
                            <h2 className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-[0.8125rem] font-medium">
                                <span className="truncate" title={list.label}>
                                    {list.label ??
                                        t(
                                            `record.related.${list.object}.${list.field}` as Parameters<
                                                typeof t
                                            >[0]
                                        )}
                                </span>
                                <span className="tabular-nums text-muted-foreground">
                                    {list.total}
                                </span>
                            </h2>
                            {list.records.length === 0 ? (
                                <p className="px-3 py-3 text-[0.8125rem] text-muted-foreground">
                                    {t("record.noRelated")}
                                </p>
                            ) : (
                                <ul className="flex flex-col gap-1 p-2">
                                    {list.records.map((ref) => (
                                        <li key={ref.id} className="min-w-0">
                                            <Link
                                                href={recordHref(list.object, ref.id)}
                                                className="flex min-w-0 rounded px-1 py-0.5 hover:bg-muted/60"
                                            >
                                                <RefChip target={list.object} value={ref} />
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {list.total > list.records.length ? (
                                <p className="border-t border-border px-3 py-2 text-[0.75rem] text-muted-foreground">
                                    {t("record.moreRelated", {
                                        count: list.total - list.records.length
                                    })}
                                </p>
                            ) : null}
                        </section>
                    ))}
                    <RecordActivities object={object} id={id} canEdit={canEdit} />
                    <Timeline
                        object={object}
                        id={id}
                        page={data?.timeline ?? null}
                        fields={fields}
                    />
                </div>
            </div>
        </div>
    );
}
