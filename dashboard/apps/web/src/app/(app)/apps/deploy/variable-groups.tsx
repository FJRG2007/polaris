"use client";

/**
 * Variable groups on screen: the shelf's groups (opened from the projects
 * list), the groups one service links with the order its variables resolve
 * in, and the tag editor projects and services share.
 *
 * A group's variables are edited with the same editor a service's are, scope
 * "group", so secrets are masked and revealed exactly as they are there.
 */

import Link from "next/link";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { normalizeTag, TAGS_MAX } from "@polaris/core/variable-groups";
import { useCallback, useEffect, useState, useTransition } from "react";
import { ArrowLeft, Layers, Lock, MoreVertical, Plus, RotateCw, Tag, Trash2, Unlink, X } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input
} from "@polaris/ui";
import { VariablesEditor } from "./variables-editor";
import { redeployEnvScopeAction } from "./variable-actions";
import * as groupActions from "./variable-group-actions";
import type { ServiceGroupsView, VariableGroupsView } from "./variable-group-actions";
import type { LinkingService } from "@/lib/deploy/variable-groups";
import type { VariableSource } from "@polaris/core/variable-groups";

const ICON_BUTTON =
    "rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

// ---------------------------------------------------------------------------
// The shelf's groups
// ---------------------------------------------------------------------------

/** Opens the shelf's variable groups from the projects list. */
export function VariableGroupsButton() {
    const t = useTranslations("deployConfig");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button variant="outline" onClick={() => setOpen(true)}>
                <Layers className="size-4" /> {t("groups.open")}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-3xl">
                    {open && <VariableGroupsManager />}
                </DialogContent>
            </Dialog>
        </>
    );
}

export function VariableGroupsManager() {
    const t = useTranslations("deployConfig");
    const [view, setView] = useState<VariableGroupsView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [pending, startTransition] = useTransition();

    const load = useCallback(() => {
        void groupActions.listVariableGroupsAction().then((result) => {
            if (result.error) setError(result.error);
            else setView({ groups: result.groups ?? [], canCreate: Boolean(result.canCreate) });
        });
    }, []);
    useEffect(load, [load]);

    function create(): void {
        setError(null);
        startTransition(async () => {
            const result = await groupActions.createVariableGroupAction({ name });
            if (result.error) return setError(result.error);
            setName("");
            load();
            if (result.id) setSelected(result.id);
        });
    }

    const group = view?.groups.find((one) => one.id === selected) ?? null;
    if (group)
        return (
            <GroupDetail
                group={group}
                onBack={() => {
                    setSelected(null);
                    load();
                }}
            />
        );

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
                <DialogTitle>{t("groups.title")}</DialogTitle>
                <p className="text-sm text-muted-foreground">{t("groups.intro")}</p>
            </DialogHeader>
            {view?.canCreate ? (
                <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (name.trim()) create();
                    }}
                >
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder={t("groups.namePlaceholder")}
                        aria-label={t("groups.name")}
                        maxLength={60}
                        className="h-8"
                    />
                    <Button type="submit" size="sm" disabled={pending || !name.trim()}>
                        <Plus className="size-4" /> {t("groups.create")}
                    </Button>
                </form>
            ) : (
                view && <p className="text-xs text-muted-foreground">{t("groups.cannotCreate")}</p>
            )}
            {error && <p className="text-sm text-danger-ink">{error}</p>}
            {view === null ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    {[0, 1, 2].map((one) => (
                        <div key={one} className="h-12 animate-pulse rounded-md bg-muted" />
                    ))}
                </div>
            ) : view.groups.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("groups.empty")}</p>
            ) : (
                <ul className="flex max-h-[60vh] flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {view.groups.map((one) => (
                        <li key={one.id}>
                            <button
                                type="button"
                                onClick={() => setSelected(one.id)}
                                className="flex w-full min-w-0 items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/60"
                            >
                                <span className="min-w-0">
                                    <span className="block truncate text-sm font-medium" title={one.name}>
                                        {one.name}
                                    </span>
                                    {one.description && (
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {one.description}
                                        </span>
                                    )}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {t("groups.counts", {
                                        variables: one.variableCount,
                                        services: one.linkCount
                                    })}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function GroupDetail({
    group,
    onBack
}: {
    group: VariableGroupsView["groups"][number];
    onBack: () => void;
}) {
    const t = useTranslations("deployConfig");
    const [name, setName] = useState(group.name);
    const [description, setDescription] = useState(group.description);
    const [deployed, setDeployed] = useState(0);
    const [usedBy, setUsedBy] = useState<{ services: LinkingService[]; hidden: number } | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const dirty = name.trim() !== group.name || description.trim() !== group.description;

    useEffect(() => {
        void groupActions.variableGroupReachAction({ groupId: group.id }).then((result) => {
            setDeployed(result.deployed ?? 0);
            setUsedBy({ services: result.services ?? [], hidden: result.hidden ?? 0 });
        });
    }, [group.id]);

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await groupActions.updateVariableGroupAction({ groupId: group.id, name, description });
            if (result.error) setError(result.error);
        });
    }

    function remove(): void {
        startTransition(async () => {
            const result = await groupActions.deleteVariableGroupAction({ groupId: group.id });
            if (result.error) return setError(result.error);
            setConfirming(false);
            onBack();
        });
    }

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
                <div className="flex min-w-0 items-center gap-2">
                    <button
                        type="button"
                        onClick={onBack}
                        className={ICON_BUTTON}
                        aria-label={t("groups.back")}
                        title={t("groups.back")}
                    >
                        <ArrowLeft className="size-4" />
                    </button>
                    <DialogTitle className="min-w-0 truncate">{group.name}</DialogTitle>
                    {group.canEdit && (
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                className={`ml-auto ${ICON_BUTTON}`}
                                aria-label={t("groups.more")}
                                title={t("groups.more")}
                            >
                                <MoreVertical className="size-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    className="text-danger-ink"
                                    onSelect={() => setConfirming(true)}
                                >
                                    <Trash2 className="size-4" /> {t("groups.delete")}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
                <p className="text-sm text-muted-foreground">
                    {group.linkCount > 0
                        ? t("groups.linkedBy", { count: group.linkCount })
                        : t("groups.linkedByNone")}
                </p>
            </DialogHeader>
            {group.canEdit ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        aria-label={t("groups.name")}
                        maxLength={60}
                        className="h-8"
                    />
                    <Input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder={t("groups.descriptionPlaceholder")}
                        aria-label={t("groups.description")}
                        maxLength={200}
                        className="h-8"
                    />
                    <Button size="sm" onClick={save} disabled={pending || !dirty || !name.trim()}>
                        {t("groups.save")}
                    </Button>
                </div>
            ) : (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="size-3.5" /> {t("groups.readOnly")}
                </p>
            )}
            {error && <p className="text-sm text-danger-ink">{error}</p>}
            {deployed > 0 && (
                <p className="text-xs text-muted-foreground">
                    {t("groups.reachesRunning", { count: deployed })}
                </p>
            )}
            {group.linkCount > 0 && <UsedBy usedBy={usedBy} />}
            <div className="max-h-[55vh] min-w-0 overflow-y-auto">
                <VariablesEditor
                    scope="group"
                    scopeId={group.id}
                    canWrite={group.canEdit}
                    canDeploy={group.canEdit && deployed > 0}
                    redeployTarget={t("groups.redeployTarget")}
                />
            </div>
            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={group.name}
                kind={t("groups.kind")}
                title={t("groups.deleteTitle")}
                confirmLabel={t("groups.delete")}
                description={
                    group.linkCount > 0
                        ? t("groups.deleteLinked", { count: group.linkCount })
                        : t("groups.deleteUnlinked")
                }
                pending={pending}
                error={error ?? undefined}
                onConfirm={remove}
            />
        </div>
    );
}

/** The services linking a group that the reader may see, each opening it. */
function UsedBy({ usedBy }: { usedBy: { services: LinkingService[]; hidden: number } | null }) {
    const t = useTranslations("deployConfig");
    return (
        <section className="flex min-w-0 flex-col gap-1.5" aria-label={t("groups.usedBy")}>
            <h3 className="text-xs font-medium text-muted-foreground">{t("groups.usedBy")}</h3>
            {usedBy === null ? (
                <div className="h-8 animate-pulse rounded-md bg-muted" aria-busy="true" />
            ) : (
                <>
                    {usedBy.services.length > 0 && (
                        <ul className="flex max-h-40 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
                            {usedBy.services.map((one) => (
                                <li key={one.applicationId}>
                                    <Link
                                        href={`/apps/deploy/${one.projectId}?service=${encodeURIComponent(one.applicationId)}`}
                                        className="flex min-w-0 items-center justify-between gap-3 px-3 py-1.5 text-sm hover:bg-muted/60"
                                    >
                                        <span className="min-w-0 truncate" title={one.name}>
                                            {one.name}
                                        </span>
                                        <span
                                            className="min-w-0 shrink truncate text-xs text-muted-foreground"
                                            title={`${one.projectName} / ${one.environmentName}`}
                                        >
                                            {one.projectName} / {one.environmentName}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                    {usedBy.hidden > 0 && (
                        <p className="text-xs text-muted-foreground">
                            {t("groups.usedByHidden", { count: usedBy.hidden })}
                        </p>
                    )}
                </>
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// One service's links and resolution order
// ---------------------------------------------------------------------------

export function sourceLabel(
    source: VariableSource,
    t: ReturnType<typeof useTranslations<"deployConfig">>
): string {
    if (source.kind === "group") return source.name;
    return source.kind === "environment" ? t("groups.sourceShared") : t("groups.sourceService");
}

/** Linked groups for one service, and the order its variables resolve in. */
export function LinkedGroupsPanel({
    applicationId,
    canDeploy
}: {
    applicationId: string;
    canDeploy: boolean;
}) {
    const t = useTranslations("deployConfig");
    const [view, setView] = useState<ServiceGroupsView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [changed, setChanged] = useState(false);
    const [redeploying, setRedeploying] = useState(false);
    const [pending, startTransition] = useTransition();

    const load = useCallback(() => {
        void groupActions.serviceVariableGroupsAction({ applicationId }).then((result) => {
            if (result.error) setError(result.error);
            else setView(result as ServiceGroupsView);
        });
    }, [applicationId]);
    useEffect(load, [load]);

    function change(action: typeof groupActions.linkVariableGroupAction, groupId: string): void {
        setError(null);
        startTransition(async () => {
            const result = await action({ applicationId, groupId });
            if (result.error) return setError(result.error);
            setChanged(true);
            setRedeploying(false);
            load();
        });
    }

    function redeploy(): void {
        startTransition(async () => {
            const result = await redeployEnvScopeAction({ scope: "application", scopeId: applicationId });
            if (result.error) return setError(result.error);
            setChanged(false);
            setRedeploying(true);
        });
    }

    if (view === null && !error)
        return <div className="h-20 animate-pulse rounded-md bg-muted" aria-busy="true" />;

    return (
        <section className="flex min-w-0 flex-col gap-3" aria-label={t("groups.linkedTitle")}>
            <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-medium">
                    <Layers className="size-4 text-muted-foreground" /> {t("groups.linkedTitle")}
                </h3>
                {view && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={!view.canLink || view.linkable.length === 0 || pending}
                                title={
                                    !view.canLink
                                        ? t("groups.cannotLink")
                                        : view.linkable.length === 0
                                          ? t("groups.nothingToLink")
                                          : undefined
                                }
                            >
                                <Plus className="size-4" /> {t("groups.link")}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                            {view.linkable.map((one) => (
                                <DropdownMenuItem
                                    key={one.id}
                                    onSelect={() => change(groupActions.linkVariableGroupAction, one.id)}
                                >
                                    <span className="truncate" title={one.name}>{one.name}</span>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
            {view && !view.canLink && (
                <p className="text-xs text-muted-foreground">{t("groups.cannotLink")}</p>
            )}
            {error && <p className="text-sm text-danger-ink">{error}</p>}
            {changed && view?.deployed && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-sm">
                    <span>{t("groups.needsRedeploy")}</span>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={redeploy}
                        disabled={!canDeploy || pending}
                        title={canDeploy ? undefined : t("groups.cannotRedeploy")}
                    >
                        <RotateCw className="size-4" /> {t("variables.redeployNow")}
                    </Button>
                </div>
            )}
            {redeploying && <p className="text-xs text-muted-foreground">{t("groups.redeploying")}</p>}
            {view && view.linked.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("groups.noneLinked")}</p>
            ) : (
                view && (
                    <ol className="flex flex-col gap-1">
                        {view.linked.map((one) => (
                            <li
                                key={one.id}
                                className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
                            >
                                <span className="min-w-0 truncate text-sm" title={one.name}>
                                    {one.name}
                                </span>
                                <span className="flex shrink-0 items-center gap-2">
                                    <span className="text-xs text-muted-foreground">
                                        {t("groups.keyCount", { count: one.keys.length })}
                                    </span>
                                    <button
                                        type="button"
                                        className={ICON_BUTTON}
                                        disabled={!view.canLink || pending}
                                        onClick={() => change(groupActions.unlinkVariableGroupAction, one.id)}
                                        aria-label={t("groups.unlink", { name: one.name })}
                                        title={
                                            view.canLink
                                                ? t("groups.unlink", { name: one.name })
                                                : t("groups.cannotLink")
                                        }
                                    >
                                        <Unlink className="size-4" />
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ol>
                )
            )}
            {view && view.resolved.length > 0 && <ResolutionOrder view={view} />}
        </section>
    );
}

export function ResolutionOrder({ view }: { view: Pick<ServiceGroupsView, "resolved" | "linked"> }) {
    const t = useTranslations("deployConfig");
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">{t("groups.orderTitle")}</h4>
            <p className="text-xs text-muted-foreground">
                {[...view.linked.map((one) => one.name), t("groups.sourceShared"), t("groups.sourceService")].join(
                    " -> "
                )}
            </p>
            <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                    <thead className="text-left text-muted-foreground">
                        <tr>
                            <th className="px-3 py-1.5 font-medium">{t("groups.colKey")}</th>
                            <th className="px-3 py-1.5 font-medium">{t("groups.colFrom")}</th>
                            <th className="px-3 py-1.5 font-medium">{t("groups.colValue")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {view.resolved.map((one) => (
                            <tr key={one.key} className="border-t border-border">
                                <td className="max-w-[14rem] truncate px-3 py-1.5 font-mono" title={one.key}>
                                    {one.key}
                                </td>
                                <td className="px-3 py-1.5">
                                    <span className="flex flex-wrap items-center gap-1">
                                        <Badge variant="neutral">{sourceLabel(one.source, t)}</Badge>
                                        {one.overridden.map((lost, index) => (
                                            <span
                                                key={index}
                                                className="text-muted-foreground line-through"
                                                title={t("groups.overridden")}
                                            >
                                                {sourceLabel(lost, t)}
                                            </span>
                                        ))}
                                    </span>
                                </td>
                                <td className="max-w-[16rem] truncate px-3 py-1.5 font-mono text-muted-foreground">
                                    {one.isSecret ? (
                                        <span className="flex items-center gap-1">
                                            <Lock className="size-3" /> {t("groups.secret")}
                                        </span>
                                    ) : one.value === null ? (
                                        t("groups.hidden")
                                    ) : (
                                        <span title={one.value}>{one.value}</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Tags as chips with an input to add one. Saved on every change. */
export function TagsEditor({
    tags,
    canEdit,
    onSave
}: {
    tags: string[];
    canEdit: boolean;
    onSave: (tags: string[]) => Promise<{ error?: string; tags?: string[] }>;
}) {
    const t = useTranslations("deployConfig");
    const [current, setCurrent] = useState(tags);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    useEffect(() => setCurrent(tags), [tags]);

    function commit(next: string[]): void {
        const previous = current;
        setCurrent(next);
        setError(null);
        startTransition(async () => {
            const result = await onSave(next);
            if (result.error) {
                setCurrent(previous);
                setError(result.error);
            } else if (result.tags) setCurrent(result.tags);
        });
    }

    function add(): void {
        const tag = normalizeTag(draft);
        setDraft("");
        if (!tag || current.includes(tag) || current.length >= TAGS_MAX) return;
        commit([...current, tag]);
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
                {current.length === 0 && (
                    <span className="text-xs text-muted-foreground">{t("tags.none")}</span>
                )}
                {current.map((tag) => (
                    <Badge key={tag} variant="neutral" className="gap-1">
                        <Tag className="size-3" />
                        <span className="max-w-[10rem] truncate" title={tag}>
                            {tag}
                        </span>
                        {canEdit && (
                            <button
                                type="button"
                                onClick={() => commit(current.filter((one) => one !== tag))}
                                disabled={pending}
                                aria-label={t("tags.remove", { tag })}
                                title={t("tags.remove", { tag })}
                                className="rounded text-muted-foreground hover:text-foreground"
                            >
                                <X className="size-3" />
                            </button>
                        )}
                    </Badge>
                ))}
            </div>
            {canEdit ? (
                <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        add();
                    }}
                >
                    <Input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={t("tags.placeholder")}
                        aria-label={t("tags.add")}
                        maxLength={32}
                        disabled={current.length >= TAGS_MAX}
                        className="h-8 max-w-xs"
                    />
                    <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        disabled={pending || !normalizeTag(draft) || current.length >= TAGS_MAX}
                        title={current.length >= TAGS_MAX ? t("tags.full", { max: TAGS_MAX }) : undefined}
                    >
                        {t("tags.add")}
                    </Button>
                </form>
            ) : (
                <p className="text-xs text-muted-foreground">{t("tags.readOnly")}</p>
            )}
            {error && <p className="text-sm text-danger-ink">{error}</p>}
        </div>
    );
}

/** A service's tags, loaded on their own so the settings tab does not wait. */
export function ServiceTags({ applicationId }: { applicationId: string }) {
    const [state, setState] = useState<{ tags: string[]; canEdit: boolean } | null>(null);
    useEffect(() => {
        void groupActions.serviceTagsAction({ applicationId }).then((result) =>
            setState({ tags: result.tags ?? [], canEdit: Boolean(result.canEdit) })
        );
    }, [applicationId]);
    if (state === null) return <div className="h-8 animate-pulse rounded-md bg-muted" aria-busy="true" />;
    return (
        <TagsEditor
            tags={state.tags}
            canEdit={state.canEdit}
            onSave={(tags) => groupActions.setServiceTagsAction({ applicationId, tags })}
        />
    );
}
