"use client";

/**
 * The connected trackers, and the form that adds one.
 *
 * The form is generated from what each provider says it needs rather than written
 * twice, so a third tracker is an entry in the catalogue and nothing here. Which
 * also means the hints on screen are the ones the provider's own settings page
 * uses - the operator is being told where to click in a product Polaris does not
 * own, and being vague about that is how an integration goes unused.
 */

import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { useEffect, useState, useTransition } from "react";
import type { TrackerView } from "@/lib/tasks/trackers/service";
import { Check, Link2, Loader2, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import {
    checkTrackerAction,
    deleteTrackerAction,
    saveTrackerAction,
    setTrackerEnabledAction,
    syncTrackerAction,
    trackerTargetsAction
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Switch
} from "@polaris/ui";

interface Space {
    id: string;
    name: string;
    lists: { id: string; name: string }[];
}

export function TrackersView({ trackers }: { trackers: TrackerView[] }) {
    const [editing, setEditing] = useState<TrackerView | "new" | null>(null);
    const [removing, setRemoving] = useState<TrackerView | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    const check = (tracker: TrackerView) => {
        startTransition(() => {
            void runAction(() => checkTrackerAction(tracker.id), setError).then((result) => {
                if (result) setNote(result.detail);
            });
        });
    };

    const sync = (tracker: TrackerView) => {
        startTransition(() => {
            void runAction(() => syncTrackerAction(tracker.id), setError).then((result) => {
                if (!result) return;
                if (result.error) setError(result.error);
                else setNote(`Brought in ${result.added ?? 0} and updated ${result.updated ?? 0}.`);
            });
        });
    };

    const toggle = (tracker: TrackerView) => {
        startTransition(() => {
            void runAction(() => setTrackerEnabledAction(tracker.id, !tracker.enabled), setError);
        });
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}

            <div className="flex justify-end">
                <Button size="sm" onClick={() => setEditing("new")}>
                    <Link2 className="size-4 shrink-0" />
                    Connect a tracker
                </Button>
            </div>

            {trackers.length === 0 ? (
                <EmptyState
                    icon={<Link2 />}
                    title="Nothing connected"
                    description="Connect Linear or Jira and their issues appear as tasks here, keeping their reference. Move one on this board and it moves there too."
                />
            ) : (
                <div className="space-y-2">
                    {trackers.map((tracker) => (
                        <Card key={tracker.id}>
                            <CardBody className="flex flex-wrap items-center gap-3">
                                <div className="min-w-0 flex-1">
                                    <p
                                        className="truncate text-sm font-medium"
                                        title={tracker.label}
                                    >
                                        {tracker.label}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {core.ISSUE_TRACKER_LABELS[tracker.provider]} into{" "}
                                        {tracker.spaceName} / {tracker.listName} - {tracker.linked}{" "}
                                        linked
                                        {tracker.syncedAt ? "" : ", never pulled"}
                                    </p>
                                    {tracker.error ? (
                                        <p className="mt-1 flex items-start gap-1 text-xs text-red-400">
                                            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                                            {tracker.error}
                                        </p>
                                    ) : null}
                                </div>
                                {tracker.pushStatus ? (
                                    <Badge variant="neutral" className="shrink-0">
                                        Two-way
                                    </Badge>
                                ) : null}
                                <Switch
                                    checked={tracker.enabled}
                                    onChange={() => toggle(tracker)}
                                />
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => check(tracker)}
                                    disabled={busy}
                                >
                                    <Check className="size-4 shrink-0" />
                                    Test
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => sync(tracker)}
                                    disabled={busy}
                                >
                                    <RefreshCw className="size-4 shrink-0" />
                                    Pull now
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setEditing(tracker)}
                                >
                                    Edit
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setRemoving(tracker)}
                                >
                                    <Trash2 className="size-4 shrink-0" />
                                </Button>
                            </CardBody>
                        </Card>
                    ))}
                </div>
            )}

            {editing ? (
                <TrackerDialog
                    tracker={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={() => setRemoving(null)}
                    name={removing.label}
                    kind="connection"
                    // Nothing is destroyed, so nothing has to be typed out: the
                    // tasks stay and the tracker is untouched.
                    requireTyping={false}
                    title={`Disconnect ${removing.label}?`}
                    question={`Disconnect ${removing.label}?`}
                    description="The tasks it brought in stay where they are and stop being kept in step. Nothing is deleted in the tracker."
                    confirmLabel="Disconnect"
                    onConfirm={async () => {
                        await runAction(() => deleteTrackerAction(removing.id), setError);
                        setRemoving(null);
                    }}
                />
            ) : null}
        </div>
    );
}

function TrackerDialog({ tracker, onClose }: { tracker: TrackerView | null; onClose: () => void }) {
    const [spaces, setSpaces] = useState<Space[] | null>(null);
    const [provider, setProvider] = useState<core.IssueTracker>(tracker?.provider ?? "linear");
    const [label, setLabel] = useState(tracker?.label ?? "");
    const [spaceId, setSpaceId] = useState(tracker?.spaceId ?? "");
    const [listId, setListId] = useState(tracker?.listId ?? "");
    const [query, setQuery] = useState(tracker?.query ?? "");
    const [config, setConfig] = useState<Record<string, string>>(tracker?.config ?? {});
    const [secret, setSecret] = useState("");
    const [pushStatus, setPushStatus] = useState(tracker?.pushStatus ?? false);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    useEffect(() => {
        void trackerTargetsAction().then((targets) => {
            setSpaces(targets.spaces);
            setSpaceId((current) => current || (targets.spaces[0]?.id ?? ""));
        });
    }, []);

    const lists = spaces?.find((space) => space.id === spaceId)?.lists ?? [];
    useEffect(() => {
        if (lists.length > 0 && !lists.some((list) => list.id === listId)) setListId(lists[0]!.id);
    }, [lists, listId]);

    const submit = () => {
        startTransition(() => {
            void runAction(
                () =>
                    saveTrackerAction({
                        id: tracker?.id ?? null,
                        provider,
                        label,
                        spaceId,
                        listId,
                        query,
                        config,
                        secret,
                        pushStatus
                    }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                else if (result) onClose();
            });
        });
    };

    return (
        <Dialog open onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {tracker ? `Edit ${tracker.label}` : "Connect a tracker"}
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">Tracker</span>
                        <Select
                            value={provider}
                            onValueChange={(value) => setProvider(value as core.IssueTracker)}
                            options={core.ISSUE_TRACKERS.map((option) => ({
                                value: option,
                                label: core.ISSUE_TRACKER_LABELS[option]
                            }))}
                            disabled={Boolean(tracker)}
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">Name it</span>
                        <Input
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                            placeholder="Product board"
                        />
                    </label>

                    {core.ISSUE_TRACKER_FIELDS[provider].map((field) => (
                        <label key={field.key} className="block space-y-1">
                            <span className="text-xs text-muted-foreground">
                                {field.label}. {field.hint}
                            </span>
                            <Input
                                type={field.secret ? "password" : "text"}
                                value={field.secret ? secret : (config[field.key] ?? "")}
                                placeholder={field.secret && tracker ? "Kept as it is" : ""}
                                onChange={(event) =>
                                    field.secret
                                        ? setSecret(event.target.value)
                                        : setConfig((current) => ({
                                              ...current,
                                              [field.key]: event.target.value
                                          }))
                                }
                            />
                        </label>
                    ))}

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">
                            {provider === "linear"
                                ? "Team key, such as ENG. Leave it empty for every issue the key can see."
                                : "JQL. Leave it empty for everything, newest first."}
                        </span>
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={
                                provider === "linear"
                                    ? "ENG"
                                    : "project = ENG AND statusCategory != Done"
                            }
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">Space</span>
                        <Select
                            value={spaceId}
                            onValueChange={setSpaceId}
                            options={(spaces ?? []).map((space) => ({
                                value: space.id,
                                label: space.name
                            }))}
                            placeholder="Pick a space"
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">List</span>
                        <Select
                            value={listId}
                            onValueChange={setListId}
                            options={lists.map((list) => ({ value: list.id, label: list.name }))}
                            placeholder="Pick a list"
                        />
                    </label>

                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                        <div className="min-w-0">
                            <p className="text-sm">Send status changes back</p>
                            <p className="text-xs text-muted-foreground">
                                Moving a task here moves the issue there. Off by default: writing
                                into somebody else&apos;s tracker is a decision, not a side effect
                                of connecting one.
                            </p>
                        </div>
                        <Switch checked={pushStatus} onChange={setPushStatus} />
                    </div>

                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={busy || !label || !spaceId || !listId}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
