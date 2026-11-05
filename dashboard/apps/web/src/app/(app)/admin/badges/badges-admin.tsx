"use client";

/**
 * The instance's own badges: make, edit and delete them, and give them to
 * people or take them back. Staff is not here - it follows the administrator
 * role by itself.
 */

import * as core from "@polaris/core";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PeoplePicker } from "@/components/people-picker";
import { BadgeIcon } from "@/components/badges/badge-icon";
import { Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { BadgeDefinitionView, BadgeHolder } from "@/lib/badges/badge-service";
import {
    Button,
    Card,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Skeleton,
    Textarea,
    useToast
} from "@polaris/ui";
import {
    badgeHoldersAction,
    createBadgeDefinitionAction,
    deleteBadgeDefinitionAction,
    grantBadgeAction,
    listBadgeDefinitionsAction,
    revokeBadgeAction,
    searchBadgePeopleAction,
    updateBadgeDefinitionAction
} from "./actions";

type Draft = { name: string; description: string; icon: core.BadgeIcon };
const EMPTY: Draft = { name: "", description: "", icon: "star" };

export function BadgesAdmin() {
    const t = useTranslations("badges");
    const toast = useToast();
    const [definitions, setDefinitions] = useState<BadgeDefinitionView[] | null>(null);
    const [editing, setEditing] = useState<BadgeDefinitionView | "new" | null>(null);
    const [removing, setRemoving] = useState<BadgeDefinitionView | null>(null);
    const [managing, setManaging] = useState<BadgeDefinitionView | null>(null);

    const reload = () =>
        listBadgeDefinitionsAction().then((answer) => {
            if (answer.error !== undefined) toast.show({ title: answer.error });
            else setDefinitions(answer.definitions);
        });

    useEffect(() => {
        void reload();
    }, []);

    const remove = async (badge: BadgeDefinitionView) => {
        const before = definitions;
        setRemoving(null);
        setDefinitions((current) => current?.filter((entry) => entry.id !== badge.id) ?? null);
        const answer = await deleteBadgeDefinitionAction(badge.id);
        if (answer.error !== undefined) {
            setDefinitions(before);
            toast.show({ title: answer.error });
        }
    };

    const changeHolders = (id: string, delta: number) =>
        setDefinitions(
            (current) =>
                current?.map((entry) =>
                    entry.id === id ? { ...entry, holders: entry.holders + delta } : entry
                ) ?? null
        );

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t("admin.intro")}</p>
                <Button size="sm" onClick={() => setEditing("new")}>
                    <Plus className="size-4" />
                    {t("admin.create")}
                </Button>
            </div>
            <Card>
                {definitions === null && (
                    <ul className="flex flex-col divide-y divide-border">
                        {[0, 1].map((index) => (
                            <li key={index} className="flex items-center gap-3 p-3">
                                <Skeleton className="size-9 rounded-full" />
                                <Skeleton className="h-4 w-48" />
                            </li>
                        ))}
                    </ul>
                )}
                {definitions?.length === 0 && <EmptyState title={t("admin.empty")} />}
                {definitions && definitions.length > 0 && (
                    <ul className="flex flex-col divide-y divide-border">
                        {definitions.map((badge) => (
                            <li key={badge.id} className="flex min-w-0 items-center gap-3 p-3">
                                <BadgeIcon
                                    icon={badge.icon}
                                    kind="custom"
                                    level={1}
                                    className="size-9 shrink-0"
                                />
                                <span className="min-w-0 flex-1">
                                    <span
                                        className="block truncate text-[0.8125rem]"
                                        title={badge.name}
                                    >
                                        {badge.name}
                                    </span>
                                    <span className="block truncate text-[0.6875rem] text-foreground-subtle">
                                        {t("admin.holders", { count: badge.holders })}
                                    </span>
                                </span>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("admin.manage", { name: badge.name })}
                                    title={t("admin.manage", { name: badge.name })}
                                    onClick={() => setManaging(badge)}
                                >
                                    <Users className="size-4" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("admin.edit", { name: badge.name })}
                                    title={t("admin.edit", { name: badge.name })}
                                    onClick={() => setEditing(badge)}
                                >
                                    <Pencil className="size-4" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("admin.remove", { name: badge.name })}
                                    title={t("admin.remove", { name: badge.name })}
                                    onClick={() => setRemoving(badge)}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            {editing && (
                <BadgeEditor
                    badge={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        void reload();
                    }}
                />
            )}

            {removing && (
                <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>{t("admin.removeTitle")}</DialogTitle>
                            <DialogDescription>
                                {t("admin.removeBody", { name: removing.name })}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex justify-end gap-2">
                            <Button variant="secondary" onClick={() => setRemoving(null)}>
                                {t("admin.cancel")}
                            </Button>
                            <Button variant="danger" onClick={() => void remove(removing)}>
                                {t("admin.removeConfirm")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {managing && (
                <HoldersDialog
                    badge={managing}
                    onChanged={(delta) => changeHolders(managing.id, delta)}
                    onClose={() => setManaging(null)}
                />
            )}
        </div>
    );
}

function BadgeEditor({
    badge,
    onClose,
    onSaved
}: {
    badge: BadgeDefinitionView | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations("badges");
    const toast = useToast();
    const initial: Draft = badge
        ? { name: badge.name, description: badge.description, icon: badge.icon }
        : EMPTY;
    const [draft, setDraft] = useState<Draft>(initial);
    const [saving, setSaving] = useState(false);
    const parsed = core.badgeDefinitionSchema.safeParse(draft);
    const dirty =
        JSON.stringify(core.badgeDefinitionSchema.safeParse(initial).data) !==
        JSON.stringify(parsed.data);
    const ready = parsed.success && (badge === null || dirty) && !saving;

    const save = async () => {
        if (!parsed.success) return;
        setSaving(true);
        const answer = badge
            ? await updateBadgeDefinitionAction(badge.id, parsed.data)
            : await createBadgeDefinitionAction(parsed.data);
        setSaving(false);
        if (answer.error !== undefined) toast.show({ title: answer.error });
        else onSaved();
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {badge ? t("admin.edit", { name: badge.name }) : t("admin.create")}
                    </DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (ready) void save();
                    }}
                >
                    <label className="flex flex-col gap-1 text-[0.8125rem]">
                        <span>{t("admin.name")} *</span>
                        <Input
                            value={draft.name}
                            maxLength={40}
                            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-[0.8125rem]">
                        <span>{t("admin.description")}</span>
                        <Textarea
                            value={draft.description}
                            maxLength={160}
                            rows={2}
                            onChange={(event) =>
                                setDraft({ ...draft, description: event.target.value })
                            }
                        />
                    </label>
                    <fieldset className="flex flex-col gap-1 text-[0.8125rem]">
                        <legend className="mb-1">{t("admin.icon")}</legend>
                        <div role="radiogroup" className="flex flex-wrap gap-2">
                            {core.BADGE_ICONS.map((icon) => (
                                <button
                                    key={icon}
                                    type="button"
                                    role="radio"
                                    aria-checked={draft.icon === icon}
                                    aria-label={t(`admin.icons.${icon}` as const)}
                                    title={t(`admin.icons.${icon}` as const)}
                                    onClick={() => setDraft({ ...draft, icon })}
                                    className={cn(
                                        "rounded-md p-1 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        draft.icon === icon
                                            ? "bg-primary/10 ring-2 ring-primary"
                                            : "hover:bg-muted"
                                    )}
                                >
                                    <BadgeIcon
                                        icon={icon}
                                        kind="custom"
                                        level={1}
                                        className="size-8"
                                    />
                                </button>
                            ))}
                        </div>
                    </fieldset>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={onClose}>
                            {t("admin.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} disabled={saving}>
                            {t("admin.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function HoldersDialog({
    badge,
    onChanged,
    onClose
}: {
    badge: BadgeDefinitionView;
    onChanged: (delta: number) => void;
    onClose: () => void;
}) {
    const t = useTranslations("badges");
    const toast = useToast();
    const [holders, setHolders] = useState<BadgeHolder[] | null>(null);
    const [next, setNext] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [loadingMore, setLoadingMore] = useState(false);
    // Only the answer to the newest search is kept; a slower older one is dropped.
    const asked = useRef(0);

    useEffect(() => {
        const ticket = ++asked.current;
        setHolders(null);
        const timer = setTimeout(
            () =>
                void badgeHoldersAction(badge.id, { query }).then((answer) => {
                    if (ticket !== asked.current) return;
                    if (answer.error !== undefined) {
                        toast.show({ title: answer.error });
                        setHolders([]);
                        return;
                    }
                    setHolders(answer.holders);
                    setNext(answer.next);
                }),
            query ? 250 : 0
        );
        return () => clearTimeout(timer);
    }, [badge.id, query]);

    const loadMore = async () => {
        if (!next || loadingMore) return;
        const ticket = asked.current;
        setLoadingMore(true);
        const answer = await badgeHoldersAction(badge.id, { query, cursor: next });
        setLoadingMore(false);
        if (ticket !== asked.current) return;
        if (answer.error !== undefined) {
            toast.show({ title: answer.error });
            return;
        }
        setHolders((current) => {
            const known = new Set((current ?? []).map((holder) => holder.id));
            return [
                ...(current ?? []),
                ...answer.holders.filter((holder) => !known.has(holder.id))
            ];
        });
        setNext(answer.next);
    };

    const grant = async (person: { id: string; name: string }) => {
        if (holders?.some((holder) => holder.id === person.id)) return;
        const before = holders;
        setHolders((current) => [
            {
                id: person.id,
                name: person.name,
                username: null,
                grantedAt: new Date().toISOString()
            },
            ...(current ?? [])
        ]);
        onChanged(1);
        const answer = await grantBadgeAction(badge.id, person.id);
        if (answer.error !== undefined) {
            setHolders(before);
            onChanged(-1);
            toast.show({ title: answer.error });
        } else if (!answer.created) {
            onChanged(-1);
        }
    };

    const revoke = async (holder: BadgeHolder) => {
        const before = holders;
        setHolders((current) => current?.filter((entry) => entry.id !== holder.id) ?? null);
        onChanged(-1);
        const answer = await revokeBadgeAction(badge.id, holder.id);
        if (answer.error !== undefined) {
            setHolders(before);
            onChanged(1);
            toast.show({ title: answer.error });
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("admin.manage", { name: badge.name })}</DialogTitle>
                </DialogHeader>
                <PeoplePicker
                    label={t("admin.grant")}
                    picked={[]}
                    exclude={(holders ?? []).map((holder) => holder.id)}
                    search={searchBadgePeopleAction}
                    onChange={(picked) => {
                        for (const person of picked) void grant(person);
                    }}
                />
                <Input
                    type="search"
                    value={query}
                    maxLength={100}
                    placeholder={t("admin.searchHolders")}
                    aria-label={t("admin.searchHolders")}
                    onChange={(event) => setQuery(event.target.value)}
                />
                {holders === null && <Skeleton className="h-10 w-full" />}
                {holders?.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                        {query.trim() ? t("admin.noMatch") : t("admin.noHolders")}
                    </p>
                )}
                {holders && holders.length > 0 && (
                    <ul className="flex max-h-72 flex-col divide-y divide-border overflow-y-auto overscroll-contain">
                        {holders.map((holder) => (
                            <li key={holder.id} className="flex min-w-0 items-center gap-2 py-2">
                                {holder.username ? (
                                    <Link
                                        href={`/u/${holder.username}`}
                                        className="min-w-0 flex-1 truncate text-[0.8125rem] hover:underline"
                                        title={holder.name}
                                    >
                                        {holder.name}
                                    </Link>
                                ) : (
                                    <span
                                        className="min-w-0 flex-1 truncate text-[0.8125rem]"
                                        title={holder.name}
                                    >
                                        {holder.name}
                                    </span>
                                )}
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("admin.revoke", {
                                        name: badge.name,
                                        person: holder.name
                                    })}
                                    title={t("admin.revoke", {
                                        name: badge.name,
                                        person: holder.name
                                    })}
                                    onClick={() => void revoke(holder)}
                                >
                                    <X className="size-4" />
                                </Button>
                            </li>
                        ))}
                        {next && (
                            <li className="py-2">
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    className="w-full"
                                    disabled={loadingMore}
                                    onClick={() => void loadMore()}
                                >
                                    {t("admin.more")}
                                </Button>
                            </li>
                        )}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
    );
}
