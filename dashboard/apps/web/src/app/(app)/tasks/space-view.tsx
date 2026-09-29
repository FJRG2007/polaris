"use client";

/**
 * A space: what is in it, and the vocabulary its lists share.
 *
 * Statuses, fields, tags and people are space-level rather than list-level, so
 * this is the one screen where changing something changes every board in the
 * space. The copy says so wherever that is not obvious - deleting a status has
 * to move the work holding it somewhere, and the picker for that is not
 * optional.
 */

import Link from "next/link";
import * as actions from "./actions";
import { useRouter } from "next/navigation";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { optionLabel } from "./option-label";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ProgressBar, StatusDot } from "./pickers";
import type { PersonRef } from "@/lib/tasks/facts";
import type { FormView } from "@/lib/tasks/form-service";
import { PersonName, PersonRow } from "@/components/person-name";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AutomationsPanel, FormsPanel } from "./automations-panel";
import type { AutomationView } from "@/lib/tasks/automation-service";
import { ChevronDown, ChevronUp, Hash, Pencil, Plus, Trash2 } from "lucide-react";
import {
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    EmptyState,
    Input,
    Select,
    cn
} from "@polaris/ui";
import type {
    CustomFieldView,
    ListSummary,
    SpaceMemberView,
    StatusView,
    TagView
} from "@/lib/tasks/space-service";

const TABS = ["Overview", "Statuses", "Fields", "Tags", "People", "Automations", "Forms"] as const;
type Tab = (typeof TABS)[number];

export interface SpaceScreenProps {
    readonly spaceId: string;
    readonly name: string;
    readonly prefix: string;
    readonly description: string;
    readonly visibility: core.SpaceVisibility;
    /** The organization this space belongs to, or null when it is somebody's
     *  own. It changes what "internal" means, so the header reads it. */
    readonly orgName: string | null;
    readonly lists: readonly ListSummary[];
    readonly statuses: readonly StatusView[];
    readonly fields: readonly CustomFieldView[];
    readonly tags: readonly TagView[];
    readonly members: readonly SpaceMemberView[];
    readonly automations: readonly AutomationView[];
    readonly forms: readonly FormView[];
    readonly people: readonly PersonRef[];
    readonly canManage: boolean;
    readonly baseUrl: string;
    /** Which tab to open on, from the URL. Anything unrecognised opens the
     *  overview rather than a blank screen. */
    readonly initialTab?: string;
}

/**
 * Who can see this space, in one line.
 *
 * Four answers rather than two, because an organization changes what both
 * settings mean: `internal` is that roster and not the instance, and even a
 * private space is reachable by whoever runs the organization.
 */
function visibilityLine(
    t: NamespaceTranslator<"tasks">,
    props: Pick<SpaceScreenProps, "visibility" | "orgName">
): string {
    if (!props.orgName) {
        return props.visibility === "internal" ? t("space.visibility.instance") : t("space.visibility.private");
    }
    return props.visibility === "internal"
        ? t("space.visibility.org", { org: props.orgName })
        : t("space.visibility.orgMembers", { org: props.orgName });
}

export function SpaceScreen(props: SpaceScreenProps) {
    const t = useTranslations("tasks");
    const [tab, setTab] = useState<Tab>(
        TABS.includes(props.initialTab as Tab) ? (props.initialTab as Tab) : "Overview"
    );
    const [error, setError] = useState("");

    const listRefs = props.lists.map((list) => ({ id: list.id, name: list.name }));
    const ruleContext = {
        spaceId: props.spaceId,
        statuses: props.statuses,
        tags: props.tags,
        fields: props.fields,
        people: props.people,
        lists: listRefs
    };

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-5">
            <header className="flex flex-wrap items-baseline gap-3">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{props.name}</h1>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
                    {props.prefix}
                </span>
                <span className="text-muted-foreground text-xs">{visibilityLine(t, props)}</span>
            </header>
            {props.description && (
                <p className="max-w-2xl text-sm text-muted-foreground">{props.description}</p>
            )}

            <nav className="flex flex-wrap gap-1 border-b border-border">
                {TABS.map((entry) => (
                    <button
                        key={entry}
                        type="button"
                        onClick={() => setTab(entry)}
                        aria-current={tab === entry}
                        className={cn(
                            "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
                            tab === entry
                                ? "border-primary font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {t(`space.tabs.${entry}`)}
                    </button>
                ))}
            </nav>

            {error && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            )}

            {tab === "Overview" && <OverviewTab lists={props.lists} />}
            {tab === "Statuses" && (
                <StatusesTab
                    spaceId={props.spaceId}
                    statuses={props.statuses}
                    canManage={props.canManage}
                    onError={setError}
                />
            )}
            {tab === "Fields" && (
                <FieldsTab
                    spaceId={props.spaceId}
                    fields={props.fields}
                    canManage={props.canManage}
                    onError={setError}
                />
            )}
            {tab === "Tags" && (
                <TagsTab
                    spaceId={props.spaceId}
                    tags={props.tags}
                    canManage={props.canManage}
                    onError={setError}
                />
            )}
            {tab === "People" && (
                <PeopleTab
                    spaceId={props.spaceId}
                    members={props.members}
                    canManage={props.canManage}
                    onError={setError}
                />
            )}
            {tab === "Automations" && (
                <AutomationsPanel automations={props.automations} context={ruleContext} />
            )}
            {tab === "Forms" && (
                <FormsPanel
                    forms={props.forms}
                    spaceId={props.spaceId}
                    lists={listRefs}
                    baseUrl={props.baseUrl}
                />
            )}
        </div>
    );
}

function OverviewTab({ lists }: { lists: readonly ListSummary[] }) {
    const t = useTranslations("tasks");
    if (lists.length === 0) {
        return (
            <EmptyState
                title={t("space.overview.emptyTitle")}
                description={t("space.overview.emptyDescription")}
            />
        );
    }
    return (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {lists.map((list) => {
                const done = list.totalCount - list.openCount;
                const percent =
                    list.totalCount === 0 ? 0 : Math.round((done / list.totalCount) * 100);
                return (
                    <li key={list.id}>
                        <Card>
                            <CardBody className="flex flex-col gap-2 p-4">
                                <Link
                                    href={`/tasks/l/${list.id}`}
                                    className="flex items-center gap-2 hover:underline"
                                >
                                    <Hash className="size-4 text-muted-foreground" />
                                    <span className="truncate font-medium">{list.name}</span>
                                </Link>
                                <ProgressBar percent={percent} />
                                <p className="text-xs text-muted-foreground">
                                    {t("space.overview.openOf", { open: list.openCount, total: list.totalCount })}
                                </p>
                            </CardBody>
                        </Card>
                    </li>
                );
            })}
        </ul>
    );
}

function StatusesTab({
    spaceId,
    statuses,
    canManage,
    onError
}: {
    spaceId: string;
    statuses: readonly StatusView[];
    canManage: boolean;
    onError: (message: string) => void;
}) {
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
    const [name, setName] = useState("");
    const [type, setType] = useState<core.TaskStatusType>("open");
    const [color, setColor] = useState("#64748b");
    const [removing, setRemoving] = useState<StatusView | null>(null);
    const [replacement, setReplacement] = useState("");
    // The status being reshaped, and the draft standing in for it until it is
    // saved. Held here rather than on the row so leaving it open on one status
    // and opening another cannot end with two half-edited rows.
    const [editing, setEditing] = useState<StatusView | null>(null);
    const [draft, setDraft] = useState<{
        name: string;
        type: core.TaskStatusType;
        color: string;
    } | null>(null);
    const [saving, setSaving] = useState(false);
    // Where a move has put things until the server says the same. The reload
    // that follows brings the new order with it, and that is when this has done
    // its job - whether or not the write landed.
    const [moved, setMoved] = useState<string[] | null>(null);

    useEffect(() => setMoved(null), [statuses]);

    const ordered = useMemo(() => {
        if (!moved) return statuses;
        const at = new Map(moved.map((id, index) => [id, index]));
        // A status the move does not name - one added since, or from another
        // window - keeps its place at the end rather than jumping to the front.
        return [...statuses].sort(
            (left, right) =>
                (at.get(left.id) ?? statuses.length) - (at.get(right.id) ?? statuses.length)
        );
    }, [statuses, moved]);

    /**
     * Move one status past its neighbour.
     *
     * The same write the board's drag makes, reachable from a keyboard and from
     * a touch screen - which a drag on a column header is not.
     */
    const move = async (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= ordered.length) return;
        const next = [...ordered];
        [next[index], next[target]] = [next[target]!, next[index]!];
        const ids = next.map((status) => status.id);
        setMoved(ids);
        const result = await runAction(() => actions.reorderStatusesAction(spaceId, ids), onError);
        if (result?.error) {
            setMoved(null);
            onError(result.error);
        }
    };

    const save = async () => {
        if (!editing || !draft?.name.trim() || saving) return;
        setSaving(true);
        const result = await runAction(
            () =>
                actions.updateStatusAction(spaceId, editing.id, {
                    name: draft.name.trim(),
                    type: draft.type,
                    color: draft.color
                }),
            onError
        );
        setSaving(false);
        if (result?.error) onError(result.error);
        else if (result) setEditing(null);
    };

    return (
        <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
                {t("space.statuses.hint")}
            </p>

            <ul className="divide-y divide-border rounded-lg border border-border">
                {ordered.map((status, index) =>
                    editing?.id === status.id && draft ? (
                        <li key={status.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                            <input
                                type="color"
                                value={draft.color}
                                aria-label={t("space.statuses.color")}
                                onChange={(event) =>
                                    setDraft({ ...draft, color: event.target.value })
                                }
                                className="h-8 w-12 shrink-0 rounded border border-border bg-field"
                            />
                            <Input
                                autoFocus
                                value={draft.name}
                                aria-label={t("space.statuses.name")}
                                onChange={(event) =>
                                    setDraft({ ...draft, name: event.target.value })
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") setEditing(null);
                                    if (event.key === "Enter") void save();
                                }}
                                className="h-8 min-w-32 flex-1 text-sm"
                            />
                            <Select
                                value={draft.type}
                                onValueChange={(value) =>
                                    setDraft({ ...draft, type: value as core.TaskStatusType })
                                }
                                options={core.TASK_STATUS_TYPES.map((entry) => ({
                                    value: entry,
                                    label: optionLabel(t, "statusType", entry)
                                }))}
                                aria-label={t("space.statuses.kind")}
                                className="h-8 w-40 text-xs"
                            />
                            <Button
                                size="sm"
                                disabled={!draft.name.trim() || saving}
                                onClick={() => void save()}
                            >
                                {saving ? t("space.saving") : tc("actions.save")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                {tc("actions.cancel")}
                            </Button>
                        </li>
                    ) : (
                        <li key={status.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                            <StatusDot color={status.color} />
                            <span className="min-w-32 flex-1 truncate text-sm" title={status.name}>
                                {status.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {optionLabel(t, "statusType", status.type)}
                            </span>
                            {canManage && (
                                <>
                                    <button
                                        type="button"
                                        disabled={index === 0}
                                        aria-label={t("space.moveUpNamed", { name: status.name })}
                                        title={t("space.moveUp")}
                                        onClick={() => void move(index, -1)}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ChevronUp className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        disabled={index === ordered.length - 1}
                                        aria-label={t("space.moveDownNamed", { name: status.name })}
                                        title={t("space.moveDown")}
                                        onClick={() => void move(index, 1)}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ChevronDown className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t("space.editNamed", { name: status.name })}
                                        title={t("space.statuses.edit")}
                                        onClick={() => {
                                            setEditing(status);
                                            setDraft({
                                                name: status.name,
                                                type: status.type,
                                                color: status.color
                                            });
                                        }}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <Pencil className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t("pickers.remove", { name: status.name })}
                                        title={t("space.statuses.remove")}
                                        onClick={() => {
                                            setRemoving(status);
                                            setReplacement(
                                                statuses.find((entry) => entry.id !== status.id)
                                                    ?.id ?? ""
                                            );
                                        }}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </>
                            )}
                        </li>
                    )
                )}
            </ul>

            {canManage && (
                <div className="flex flex-wrap items-end gap-2">
                    <Input
                        value={name}
                        placeholder={t("space.statuses.name")}
                        aria-label={t("space.statuses.name")}
                        onChange={(event) => setName(event.target.value)}
                        className="h-8 w-44 text-sm"
                    />
                    <Select
                        value={type}
                        onValueChange={(value) => setType(value as core.TaskStatusType)}
                        options={core.TASK_STATUS_TYPES.map((entry) => ({
                            value: entry,
                            label: optionLabel(t, "statusType", entry)
                        }))}
                        aria-label={t("space.statuses.kind")}
                        className="h-8 w-40 text-xs"
                    />
                    <input
                        type="color"
                        value={color}
                        aria-label={t("space.statuses.color")}
                        onChange={(event) => setColor(event.target.value)}
                        className="h-8 w-12 rounded border border-border bg-field"
                    />
                    <Button
                        size="sm"
                        disabled={!name.trim()}
                        onClick={async () => {
                            const result = await runAction(
                                () =>
                                    actions.createStatusAction(spaceId, {
                                        name: name.trim(),
                                        type,
                                        color
                                    }),
                                onError
                            );
                            if (result?.error) onError(result.error);
                            else setName("");
                        }}
                    >
                        <Plus className="size-3.5" /> {t("goals.add")}
                    </Button>
                    <p className="w-full text-xs text-muted-foreground">
                        {optionLabel(t, "statusTypeHint", type)}
                    </p>
                </div>
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (open ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind="status"
                title={t("space.statuses.deleteTitle")}
                description={t("space.statuses.removeDescription")}
                confirmLabel={t("space.statuses.remove")}
                onConfirm={async () => {
                    if (!removing || !replacement) return;
                    const result = await runAction(
                        () =>
                            actions.deleteStatusAction(spaceId, removing.id, {
                                kind: "move",
                                replacementId: replacement
                            }),
                        onError
                    );
                    if (result?.error) onError(result.error);
                    setRemoving(null);
                }}
            >
                <label className="flex flex-col gap-1 text-sm">
                    {t("space.statuses.moveTasksTo")}
                    <Select
                        value={replacement}
                        onValueChange={setReplacement}
                        options={statuses
                            .filter((status) => status.id !== removing?.id)
                            .map((status) => ({ value: status.id, label: status.name }))}
                        aria-label={t("space.statuses.replacement")}
                        className="h-8 text-xs"
                    />
                </label>
            </ConfirmDeleteDialog>
        </section>
    );
}

function FieldsTab({
    spaceId,
    fields,
    canManage,
    onError
}: {
    spaceId: string;
    fields: readonly CustomFieldView[];
    canManage: boolean;
    onError: (message: string) => void;
}) {
    const t = useTranslations("tasks");
    const [name, setName] = useState("");
    const [type, setType] = useState<core.CustomFieldType>("text");

    return (
        <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
                {t("space.fields.hint")}
            </p>

            <ul className="divide-y divide-border rounded-lg border border-border">
                {fields.length === 0 && (
                    <li className="px-3 py-4 text-xs text-muted-foreground">{t("space.fields.empty")}</li>
                )}
                {fields.map((field) => (
                    <li key={field.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="flex-1 truncate text-sm">{field.name}</span>
                        <span className="text-xs text-muted-foreground">
                            {optionLabel(t, "customField", field.type)}
                        </span>
                        {canManage && (
                            <button
                                type="button"
                                aria-label={t("pickers.remove", { name: field.name })}
                                title={t("space.fields.remove")}
                                onClick={async () => {
                                    const result = await runAction(
                                        () => actions.deleteCustomFieldAction(spaceId, field.id),
                                        onError
                                    );
                                    if (result?.error) onError(result.error);
                                }}
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                            >
                                <Trash2 className="size-3.5" />
                            </button>
                        )}
                    </li>
                ))}
            </ul>

            {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        value={name}
                        placeholder={t("space.fields.name")}
                        aria-label={t("space.fields.name")}
                        onChange={(event) => setName(event.target.value)}
                        className="h-8 w-44 text-sm"
                    />
                    <Select
                        value={type}
                        onValueChange={(value) => setType(value as core.CustomFieldType)}
                        options={core.CUSTOM_FIELD_TYPES.map((entry) => ({
                            value: entry,
                            label: optionLabel(t, "customField", entry)
                        }))}
                        aria-label={t("space.fields.type")}
                        className="h-8 w-40 text-xs"
                    />
                    <Button
                        size="sm"
                        disabled={!name.trim()}
                        onClick={async () => {
                            const result = await runAction(
                                () =>
                                    actions.createCustomFieldAction({
                                        spaceId,
                                        name: name.trim(),
                                        type,
                                        config: {},
                                        required: false,
                                        showOnCard: false
                                    }),
                                onError
                            );
                            if (result?.error) onError(result.error);
                            else setName("");
                        }}
                    >
                        <Plus className="size-3.5" /> {t("goals.add")}
                    </Button>
                </div>
            )}
        </section>
    );
}

/**
 * The tags a space uses, and the only screen that can take one back.
 *
 * A tag is made from the picker on a task, which is where somebody needs one -
 * and that is also why this screen matters: a name typed in a hurry, or the same
 * idea spelled two ways, is a tag that exists forever unless there is somewhere
 * to rename it and somewhere to remove it. The picker links here for that
 * reason; before it did, the only way to find this was to know it was here.
 *
 * Removing one is confirmed, because a tag belongs to the space rather than to
 * the task it is being looked at from: it comes off every task in the space at
 * once, and nothing about the press says so.
 */
function TagsTab({
    spaceId,
    tags,
    canManage,
    onError
}: {
    spaceId: string;
    tags: readonly TagView[];
    canManage: boolean;
    onError: (message: string) => void;
}) {
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
    const [name, setName] = useState("");
    const [color, setColor] = useState("#7c5cff");
    /** The tag being renamed, and what it is being renamed to. Held apart from
     *  the row so cancelling puts the stored one back rather than whatever was
     *  half-typed. */
    const [editing, setEditing] = useState<TagView | null>(null);
    const [draft, setDraft] = useState<{ name: string; color: string } | null>(null);
    const [saving, setSaving] = useState(false);
    const [removing, setRemoving] = useState<TagView | null>(null);
    // Adding one is the single write here the action does not re-render for: it
    // is the same call the task pickers make, and there it must leave the task
    // being written alone. This screen is the one place a new tag has to appear
    // in a list that came from the server, so it asks for the list itself.
    const router = useRouter();

    const save = async () => {
        if (!editing || !draft || !draft.name.trim()) return;
        setSaving(true);
        const result = await runAction(
            () => actions.updateTagAction(spaceId, editing.id, draft.name.trim(), draft.color),
            onError
        );
        setSaving(false);
        if (result?.error) onError(result.error);
        else if (result) setEditing(null);
    };

    return (
        <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
                {t("space.tags.hint")}
            </p>

            <ul className="divide-y divide-border rounded-lg border border-border">
                {tags.length === 0 && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">{t("space.tags.empty")}</li>
                )}
                {tags.map((tag) =>
                    editing?.id === tag.id && draft ? (
                        <li key={tag.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                            <input
                                type="color"
                                value={draft.color}
                                aria-label={t("space.tags.color")}
                                onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                                className="h-8 w-12 shrink-0 rounded border border-border bg-field"
                            />
                            <Input
                                autoFocus
                                value={draft.name}
                                aria-label={t("space.tags.name")}
                                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") setEditing(null);
                                    if (event.key === "Enter") void save();
                                }}
                                className="h-8 min-w-32 flex-1 text-sm"
                            />
                            <Button size="sm" disabled={!draft.name.trim() || saving} onClick={() => void save()}>
                                {saving ? t("space.saving") : tc("actions.save")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                {tc("actions.cancel")}
                            </Button>
                        </li>
                    ) : (
                        <li key={tag.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                            <span
                                className="inline-flex items-center rounded-md px-2 py-0.5 text-xs"
                                style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                            >
                                {tag.name}
                            </span>
                            <span className="flex-1" />
                            {canManage && (
                                <>
                                    <button
                                        type="button"
                                        aria-label={t("space.editNamed", { name: tag.name })}
                                        title={t("space.tags.edit")}
                                        onClick={() => {
                                            setEditing(tag);
                                            setDraft({ name: tag.name, color: tag.color });
                                        }}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <Pencil className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t("pickers.remove", { name: tag.name })}
                                        title={t("space.tags.remove")}
                                        onClick={() => setRemoving(tag)}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </>
                            )}
                        </li>
                    )
                )}
            </ul>

            {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        value={name}
                        placeholder={t("space.tags.name")}
                        aria-label={t("space.tags.name")}
                        onChange={(event) => setName(event.target.value)}
                        className="h-8 w-44 text-sm"
                    />
                    <input
                        type="color"
                        value={color}
                        aria-label={t("space.tags.color")}
                        onChange={(event) => setColor(event.target.value)}
                        className="h-8 w-12 rounded border border-border bg-field"
                    />
                    <Button
                        size="sm"
                        disabled={!name.trim()}
                        onClick={async () => {
                            const result = await runAction(
                                () => actions.createTagAction(spaceId, name.trim(), color),
                                onError
                            );
                            if (result?.error) onError(result.error);
                            else if (result) {
                                setName("");
                                router.refresh();
                            }
                        }}
                    >
                        <Plus className="size-3.5" /> {t("goals.add")}
                    </Button>
                </div>
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (open ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind="tag"
                // One row of many, and it holds no work of its own: typing the
                // name back would be a ceremony for taking off a label.
                requireTyping={false}
                title={t("space.tags.deleteTitle")}
                question={t.rich("deleteTask.question", {
                    name: removing?.name ?? "",
                    strong: (chunks) => <span key="name" className="font-medium text-foreground">{chunks}</span>
                })}
                description={t("space.tags.removeDescription")}
                confirmLabel={t("space.tags.remove")}
                onConfirm={async () => {
                    if (!removing) return;
                    const result = await runAction(
                        () => actions.deleteTagAction(spaceId, removing.id),
                        onError
                    );
                    if (result?.error) onError(result.error);
                    setRemoving(null);
                }}
            />
        </section>
    );
}

function PeopleTab({
    spaceId,
    members,
    canManage,
    onError
}: {
    spaceId: string;
    members: readonly SpaceMemberView[];
    canManage: boolean;
    onError: (message: string) => void;
}) {
    const t = useTranslations("tasks");
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<core.SpaceRole>("member");

    return (
        <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
                {t("space.people.hint")}
            </p>
            <ul className="divide-y divide-border rounded-lg border border-border">
                {members.map((member) => (
                    <PersonRow
                        as="li"
                        key={member.userId}
                        personId={member.userId}
                        className="flex flex-wrap items-center gap-3 px-3 py-2"
                    >
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm" title={member.name}>
                                <PersonName id={member.userId} name={member.name} />
                            </p>
                            <p
                                className="truncate text-xs text-muted-foreground"
                                title={member.contact}
                            >
                                {member.contact}
                            </p>
                        </div>
                        {member.role === "owner" ? (
                            <span className="text-xs text-muted-foreground">{t("access.owner")}</span>
                        ) : canManage ? (
                            <>
                                <Select
                                    value={member.role}
                                    onValueChange={async (next) => {
                                        const result = await runAction(
                                            () =>
                                                actions.setSpaceMemberRoleAction(
                                                    spaceId,
                                                    member.userId,
                                                    next as core.SpaceRole
                                                ),
                                            onError
                                        );
                                        if (result?.error) onError(result.error);
                                    }}
                                    options={core.SPACE_ROLES.map((entry) => ({
                                        value: entry,
                                        label: optionLabel(t, "spaceRole", entry)
                                    }))}
                                    aria-label={t("access.roleFor", { name: member.name })}
                                    className="h-8 w-32 text-xs"
                                />
                                <button
                                    type="button"
                                    aria-label={t("pickers.remove", { name: member.name })}
                                    title={t("space.people.remove")}
                                    onClick={async () => {
                                        const result = await runAction(
                                            () =>
                                                actions.removeSpaceMemberAction(
                                                    spaceId,
                                                    member.userId
                                                ),
                                            onError
                                        );
                                        if (result?.error) onError(result.error);
                                    }}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            </>
                        ) : (
                            <span className="text-xs text-muted-foreground">
                                {optionLabel(t, "spaceRole", member.role)}
                            </span>
                        )}
                    </PersonRow>
                ))}
            </ul>

            {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        value={identifier}
                        placeholder={t("access.identifier")}
                        aria-label={t("space.people.add")}
                        onChange={(event) => setIdentifier(event.target.value)}
                        className="h-8 w-56 text-sm"
                    />
                    <Select
                        value={role}
                        onValueChange={(value) => setRole(value as core.SpaceRole)}
                        options={core.SPACE_ROLES.map((entry) => ({
                            value: entry,
                            label: optionLabel(t, "spaceRole", entry)
                        }))}
                        aria-label={t("access.role")}
                        className="h-8 w-32 text-xs"
                    />
                    <Button
                        size="sm"
                        disabled={!identifier.trim()}
                        onClick={async () => {
                            const result = await runAction(
                                () =>
                                    actions.addSpaceMemberAction(spaceId, identifier.trim(), role),
                                onError
                            );
                            if (result?.error) onError(result.error);
                            else setIdentifier("");
                        }}
                    >
                        <Plus className="size-3.5" /> {t("goals.add")}
                    </Button>
                    <p className="w-full text-xs text-muted-foreground">
                        {optionLabel(t, "spaceRoleHint", role)}
                    </p>
                </div>
            )}

            <SpaceTeams spaceId={spaceId} canManage={canManage} onError={onError} />
        </section>
    );
}

/**
 * The teams that hold this space.
 *
 * Loaded when the tab opens rather than sent with the page, because a personal
 * space has no teams to show and most spaces are personal. When there are none
 * to offer it says why instead of rendering an empty picker somebody has to
 * work out the meaning of.
 */
function SpaceTeams({
    spaceId,
    canManage,
    onError
}: {
    spaceId: string;
    canManage: boolean;
    onError: (message: string) => void;
}) {
    const [granted, setGranted] = useState<
        { teamId: string; teamName: string; role: core.SpaceRole }[]
    >([]);
    const t = useTranslations("tasks");
    const [available, setAvailable] = useState<{ id: string; name: string }[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [pick, setPick] = useState("");
    const [role, setRole] = useState<core.SpaceRole>("member");

    const reload = useCallback(async () => {
        const result = await runAction(() => actions.spaceTeamsAction(spaceId), onError);
        if (result?.error) onError(result.error);
        setGranted(result?.granted ?? []);
        setAvailable(result?.available ?? []);
        setLoaded(true);
    }, [spaceId, onError]);

    useEffect(() => {
        void reload();
    }, [reload]);

    // Nothing to say on a personal space: no teams exist to give it to, and an
    // empty section would only raise a question the screen cannot answer.
    if (!loaded || (available.length === 0 && granted.length === 0)) return null;

    const ungranted = available.filter(
        (team) => !granted.some((grant) => grant.teamId === team.id)
    );

    return (
        <section className="flex flex-col gap-3 border-t border-border pt-4">
            <div>
                <h2 className="text-sm font-medium">{t("access.teams")}</h2>
                <p className="text-xs text-muted-foreground">{t("space.teams.hint")}</p>
            </div>

            {granted.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    {t("space.teams.empty")}
                </p>
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {granted.map((grant) => (
                        <li
                            key={grant.teamId}
                            className="flex flex-wrap items-center gap-3 px-3 py-2"
                        >
                            <p className="min-w-0 flex-1 truncate text-sm" title={grant.teamName}>
                                {grant.teamName}
                            </p>
                            {canManage ? (
                                <>
                                    <Select
                                        value={grant.role}
                                        onValueChange={async (next) => {
                                            const result = await runAction(
                                                () =>
                                                    actions.grantSpaceTeamAction(
                                                        spaceId,
                                                        grant.teamId,
                                                        next as core.SpaceRole
                                                    ),
                                                onError
                                            );
                                            if (result?.error) onError(result.error);
                                            await reload();
                                        }}
                                        options={core.SPACE_ROLES.map((entry) => ({
                                            value: entry,
                                            label: optionLabel(t, "spaceRole", entry)
                                        }))}
                                        aria-label={t("access.roleFor", { name: grant.teamName })}
                                        className="h-8 w-32 text-xs"
                                    />
                                    <button
                                        type="button"
                                        aria-label={t("pickers.remove", { name: grant.teamName })}
                                        title={t("space.people.remove")}
                                        onClick={async () => {
                                            const result = await runAction(
                                                () =>
                                                    actions.revokeSpaceTeamAction(
                                                        spaceId,
                                                        grant.teamId
                                                    ),
                                                onError
                                            );
                                            if (result?.error) onError(result.error);
                                            await reload();
                                        }}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    {optionLabel(t, "spaceRole", grant.role)}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {canManage && ungranted.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        value={pick}
                        onValueChange={setPick}
                        placeholder={t("access.chooseTeam")}
                        options={ungranted.map((team) => ({ value: team.id, label: team.name }))}
                        aria-label={t("access.teamToAdd")}
                        className="h-8 w-56 text-sm"
                    />
                    <Select
                        value={role}
                        onValueChange={(value) => setRole(value as core.SpaceRole)}
                        options={core.SPACE_ROLES.map((entry) => ({
                            value: entry,
                            label: optionLabel(t, "spaceRole", entry)
                        }))}
                        aria-label={t("access.teamRole")}
                        className="h-8 w-32 text-xs"
                    />
                    <Button
                        size="sm"
                        disabled={!pick}
                        onClick={async () => {
                            const result = await runAction(
                                () => actions.grantSpaceTeamAction(spaceId, pick, role),
                                onError
                            );
                            if (result?.error) onError(result.error);
                            else setPick("");
                            await reload();
                        }}
                    >
                        <Plus className="size-3.5" /> {t("access.give")}
                    </Button>
                </div>
            )}
        </section>
    );
}
