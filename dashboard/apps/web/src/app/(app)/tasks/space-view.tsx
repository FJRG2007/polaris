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
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { ProgressBar, StatusDot } from "./pickers";
import type { PersonRef } from "@/lib/tasks/facts";
import type { FormView } from "@/lib/tasks/form-service";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AutomationsPanel, FormsPanel } from "./automations-panel";
import type { AutomationView } from "@/lib/tasks/automation-service";
import { ChevronDown, ChevronUp, Hash, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Card, CardBody, ConfirmDeleteDialog, EmptyState, Input, Select, cn } from "@polaris/ui";
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
function visibilityLine(props: Pick<SpaceScreenProps, "visibility" | "orgName">): string {
    if (!props.orgName) {
        return props.visibility === "internal"
            ? "Anyone on this Polaris can see it"
            : "Private to its members";
    }
    return props.visibility === "internal"
        ? `Anyone in ${props.orgName} can see it`
        : `${props.orgName} - its teams and members`;
}

export function SpaceScreen(props: SpaceScreenProps) {
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
                <h1 className="text-[17px] font-semibold tracking-tight">{props.name}</h1>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {props.prefix}
                </span>
                <span className="text-muted-foreground text-xs">{visibilityLine(props)}</span>
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
                        {entry}
                    </button>
                ))}
            </nav>

            {error && (
                <p
                    role="alert"
                    className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
                >
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
    if (lists.length === 0) {
        return (
            <EmptyState title="No lists yet." description="Add one from the sidebar and its tasks appear here." />
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
                                    {list.openCount} open of {list.totalCount}
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
                Every list in this space shares these. The kind decides what Polaris counts as
                finished, whatever the status is called, and the order here is the order of the
                columns on a board. Move one with the arrows, or drag its column on a board.
            </p>

            <ul className="divide-y divide-border rounded-lg border border-border">
                {ordered.map((status, index) =>
                    editing?.id === status.id && draft ? (
                        <li key={status.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                            <input
                                type="color"
                                value={draft.color}
                                aria-label="Status colour"
                                onChange={(event) =>
                                    setDraft({ ...draft, color: event.target.value })
                                }
                                className="h-8 w-12 shrink-0 rounded border border-border bg-background"
                            />
                            <Input
                                autoFocus
                                value={draft.name}
                                aria-label="Status name"
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
                                    label: core.TASK_STATUS_TYPE_LABELS[entry]
                                }))}
                                aria-label="Status kind"
                                className="h-8 w-40 text-xs"
                            />
                            <Button
                                size="sm"
                                disabled={!draft.name.trim() || saving}
                                onClick={() => void save()}
                            >
                                {saving ? "Saving..." : "Save"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                Cancel
                            </Button>
                        </li>
                    ) : (
                        <li key={status.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                            <StatusDot color={status.color} />
                            <span className="min-w-32 flex-1 truncate text-sm" title={status.name}>
                                {status.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {core.TASK_STATUS_TYPE_LABELS[status.type]}
                            </span>
                            {canManage && (
                                <>
                                    <button
                                        type="button"
                                        disabled={index === 0}
                                        aria-label={`Move ${status.name} up`}
                                        title="Move up"
                                        onClick={() => void move(index, -1)}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ChevronUp className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        disabled={index === ordered.length - 1}
                                        aria-label={`Move ${status.name} down`}
                                        title="Move down"
                                        onClick={() => void move(index, 1)}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ChevronDown className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={`Edit ${status.name}`}
                                        title="Edit status"
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
                                        aria-label={`Remove ${status.name}`}
                                        title="Remove status"
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
                        placeholder="Status name"
                        aria-label="Status name"
                        onChange={(event) => setName(event.target.value)}
                        className="h-8 w-44 text-sm"
                    />
                    <Select
                        value={type}
                        onValueChange={(value) => setType(value as core.TaskStatusType)}
                        options={core.TASK_STATUS_TYPES.map((entry) => ({
                            value: entry,
                            label: core.TASK_STATUS_TYPE_LABELS[entry]
                        }))}
                        aria-label="Status kind"
                        className="h-8 w-40 text-xs"
                    />
                    <input
                        type="color"
                        value={color}
                        aria-label="Status colour"
                        onChange={(event) => setColor(event.target.value)}
                        className="h-8 w-12 rounded border border-border bg-background"
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
                        <Plus className="size-3.5" /> Add
                    </Button>
                    <p className="w-full text-xs text-muted-foreground">
                        {core.TASK_STATUS_TYPE_HINTS[type]}
                    </p>
                </div>
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (open ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind="status"
                description="Tasks on it move to the status you pick, so nothing falls off the board."
                confirmLabel="Remove status"
                onConfirm={async () => {
                    if (!removing || !replacement) return;
                    const result = await runAction(
                        () => actions.deleteStatusAction(spaceId, removing.id, replacement),
                        onError
                    );
                    if (result?.error) onError(result.error);
                    setRemoving(null);
                }}
            >
                <label className="flex flex-col gap-1 text-sm">
                    Move its tasks to
                    <Select
                        value={replacement}
                        onValueChange={setReplacement}
                        options={statuses
                            .filter((status) => status.id !== removing?.id)
                            .map((status) => ({ value: status.id, label: status.name }))}
                        aria-label="Replacement status"
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
    const [name, setName] = useState("");
    const [type, setType] = useState<core.CustomFieldType>("text");

    return (
        <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
                Extra columns on every task in this space. They show in the table view and on the
                task panel.
            </p>

            <ul className="divide-y divide-border rounded-lg border border-border">
                {fields.length === 0 && (
                    <li className="px-3 py-4 text-xs text-muted-foreground">No fields yet.</li>
                )}
                {fields.map((field) => (
                    <li key={field.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="flex-1 truncate text-sm">{field.name}</span>
                        <span className="text-xs text-muted-foreground">
                            {core.CUSTOM_FIELD_LABELS[field.type]}
                        </span>
                        {canManage && (
                            <button
                                type="button"
                                aria-label={`Remove ${field.name}`}
                                title="Remove field"
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
                        placeholder="Field name"
                        aria-label="Field name"
                        onChange={(event) => setName(event.target.value)}
                        className="h-8 w-44 text-sm"
                    />
                    <Select
                        value={type}
                        onValueChange={(value) => setType(value as core.CustomFieldType)}
                        options={core.CUSTOM_FIELD_TYPES.map((entry) => ({
                            value: entry,
                            label: core.CUSTOM_FIELD_LABELS[entry]
                        }))}
                        aria-label="Field type"
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
                        <Plus className="size-3.5" /> Add
                    </Button>
                </div>
            )}
        </section>
    );
}

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
    const [name, setName] = useState("");
    const [color, setColor] = useState("#7c5cff");

    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
                {tags.length === 0 && <p className="text-xs text-muted-foreground">No tags yet.</p>}
                {tags.map((tag) => (
                    <span
                        key={tag.id}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                        style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                    >
                        {tag.name}
                        {canManage && (
                            <button
                                type="button"
                                aria-label={`Remove ${tag.name}`}
                                title="Remove tag"
                                onClick={async () => {
                                    const result = await runAction(
                                        () => actions.deleteTagAction(spaceId, tag.id),
                                        onError
                                    );
                                    if (result?.error) onError(result.error);
                                }}
                                className="opacity-70 hover:opacity-100"
                            >
                                <Trash2 className="size-3" />
                            </button>
                        )}
                    </span>
                ))}
            </div>

            {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        value={name}
                        placeholder="Tag name"
                        aria-label="Tag name"
                        onChange={(event) => setName(event.target.value)}
                        className="h-8 w-44 text-sm"
                    />
                    <input
                        type="color"
                        value={color}
                        aria-label="Tag colour"
                        onChange={(event) => setColor(event.target.value)}
                        className="h-8 w-12 rounded border border-border bg-background"
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
                            else setName("");
                        }}
                    >
                        <Plus className="size-3.5" /> Add
                    </Button>
                </div>
            )}
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
    const [identifier, setIdentifier] = useState("");
    const [role, setRole] = useState<core.SpaceRole>("member");

    return (
        <section className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
                Everyone here reaches the whole space. To give somebody one client or one project
                instead, right-click that folder in the sidebar and choose who can reach it.
            </p>
            <ul className="divide-y divide-border rounded-lg border border-border">
                {members.map((member) => (
                    <li key={member.userId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm" title={member.name}>
                                {member.name}
                            </p>
                            <p
                                className="truncate text-xs text-muted-foreground"
                                title={member.contact}
                            >
                                {member.contact}
                            </p>
                        </div>
                        {member.role === "owner" ? (
                            <span className="text-xs text-muted-foreground">Owner</span>
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
                                        label: core.SPACE_ROLE_LABELS[entry]
                                    }))}
                                    aria-label={`Role for ${member.name}`}
                                    className="h-8 w-32 text-xs"
                                />
                                <button
                                    type="button"
                                    aria-label={`Remove ${member.name}`}
                                    title="Remove from space"
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
                                {core.SPACE_ROLE_LABELS[member.role]}
                            </span>
                        )}
                    </li>
                ))}
            </ul>

            {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        value={identifier}
                        placeholder="Email or username"
                        aria-label="Person to add"
                        onChange={(event) => setIdentifier(event.target.value)}
                        className="h-8 w-56 text-sm"
                    />
                    <Select
                        value={role}
                        onValueChange={(value) => setRole(value as core.SpaceRole)}
                        options={core.SPACE_ROLES.map((entry) => ({
                            value: entry,
                            label: core.SPACE_ROLE_LABELS[entry]
                        }))}
                        aria-label="Role"
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
                        <Plus className="size-3.5" /> Add
                    </Button>
                    <p className="w-full text-xs text-muted-foreground">
                        {core.SPACE_ROLE_HINTS[role]}
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
                <h2 className="text-sm font-medium">Teams</h2>
                <p className="text-xs text-muted-foreground">
                    A team from the organization that owns this space. Everybody on it reaches the
                    space at the role given here, and joining the team later is enough.
                </p>
            </div>

            {granted.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    No team has been given this space yet.
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
                                            label: core.SPACE_ROLE_LABELS[entry]
                                        }))}
                                        aria-label={`Role for ${grant.teamName}`}
                                        className="h-8 w-32 text-xs"
                                    />
                                    <button
                                        type="button"
                                        aria-label={`Remove ${grant.teamName}`}
                                        title="Remove from space"
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
                                    {core.SPACE_ROLE_LABELS[grant.role]}
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
                        placeholder="Choose a team"
                        options={ungranted.map((team) => ({ value: team.id, label: team.name }))}
                        aria-label="Team to add"
                        className="h-8 w-56 text-sm"
                    />
                    <Select
                        value={role}
                        onValueChange={(value) => setRole(value as core.SpaceRole)}
                        options={core.SPACE_ROLES.map((entry) => ({
                            value: entry,
                            label: core.SPACE_ROLE_LABELS[entry]
                        }))}
                        aria-label="Role for the team"
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
                        <Plus className="size-3.5" /> Give access
                    </Button>
                </div>
            )}
        </section>
    );
}
