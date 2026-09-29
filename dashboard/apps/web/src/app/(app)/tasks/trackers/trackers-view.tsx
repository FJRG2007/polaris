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
import { trackerSentence } from "./tracker-sentence";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("tasks");
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
                else setNote(t("trackers.pulled", { added: result.added ?? 0, updated: result.updated ?? 0 }));
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
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}

            <div className="flex justify-end">
                <Button size="sm" onClick={() => setEditing("new")}>
                    <Link2 className="size-4 shrink-0" />
                    {t("trackers.connect")}
                </Button>
            </div>

            {trackers.length === 0 ? (
                <EmptyState
                    icon={<Link2 />}
                    title={t("trackers.emptyTitle")}
                    description={t("trackers.emptyDescription")}
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
                                        {tracker.syncedAt
                                            ? t("trackers.summary", {
                                                  provider: core.ISSUE_TRACKER_LABELS[tracker.provider],
                                                  space: tracker.spaceName,
                                                  list: tracker.listName,
                                                  linked: tracker.linked
                                              })
                                            : t("trackers.summaryNeverPulled", {
                                                  provider: core.ISSUE_TRACKER_LABELS[tracker.provider],
                                                  space: tracker.spaceName,
                                                  list: tracker.listName,
                                                  linked: tracker.linked
                                              })}
                                    </p>
                                    {tracker.error ? (
                                        <p className="mt-1 flex items-start gap-1 text-xs text-danger">
                                            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                                            {trackerSentence(t, tracker.error)}
                                        </p>
                                    ) : null}
                                </div>
                                {tracker.pushStatus ? (
                                    <Badge variant="neutral" className="shrink-0">
                                        {t("trackers.twoWay")}
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
                                    {t("trackers.test")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => sync(tracker)}
                                    disabled={busy}
                                >
                                    <RefreshCw className="size-4 shrink-0" />
                                    {t("trackers.pullNow")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setEditing(tracker)}
                                >
                                    {t("trackers.edit")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setRemoving(tracker)}
                                    aria-label={t("trackers.disconnectNamed", { name: tracker.label })}
                                    title={t("trackers.disconnect")}
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
                    title={t("trackers.disconnectQuestion", { name: removing.label })}
                    question={t("trackers.disconnectQuestion", { name: removing.label })}
                    description={t("trackers.disconnectDescription")}
                    confirmLabel={t("trackers.disconnect")}
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
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
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
                        {tracker ? t("trackers.editNamed", { name: tracker.label }) : t("trackers.connect")}
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("trackers.tracker")}</span>
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
                        <span className="text-xs text-muted-foreground">{t("trackers.nameIt")}</span>
                        <Input
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                            placeholder={t("trackers.namePlaceholder")}
                        />
                    </label>

                    {core.ISSUE_TRACKER_FIELDS[provider].map((field) => (
                        <label key={field.key} className="block space-y-1">
                            <span className="text-xs text-muted-foreground">
                                {t("trackers.fieldLine", {
                                    label: t(`trackers.fields.${field.key}.label` as NamespaceKey<"tasks">),
                                    hint: t(`trackers.fields.${field.key}.hint` as NamespaceKey<"tasks">)
                                })}
                            </span>
                            <Input
                                type={field.secret ? "password" : "text"}
                                value={field.secret ? secret : (config[field.key] ?? "")}
                                placeholder={field.secret && tracker ? t("trackers.keptAsIs") : ""}
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
                            {provider === "linear" ? t("trackers.linearQuery") : t("trackers.jiraQuery")}
                        </span>
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={
                                provider === "linear"
                                    ? "ENG" // i18n-ignore
                                    : "project = ENG AND statusCategory != Done" // i18n-ignore
                            }
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("trackers.space")}</span>
                        <Select
                            value={spaceId}
                            onValueChange={setSpaceId}
                            options={(spaces ?? []).map((space) => ({
                                value: space.id,
                                label: space.name
                            }))}
                            placeholder={t("trackers.pickSpace")}
                        />
                    </label>

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">{t("trackers.list")}</span>
                        <Select
                            value={listId}
                            onValueChange={setListId}
                            options={lists.map((list) => ({ value: list.id, label: list.name }))}
                            placeholder={t("trackers.pickList")}
                        />
                    </label>

                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                        <div className="min-w-0">
                            <p className="text-sm">{t("trackers.push")}</p>
                            <p className="text-xs text-muted-foreground">{t("trackers.pushHint")}</p>
                        </div>
                        <Switch checked={pushStatus} onChange={setPushStatus} />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button onClick={submit} disabled={busy || !label || !spaceId || !listId}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {tc("actions.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
