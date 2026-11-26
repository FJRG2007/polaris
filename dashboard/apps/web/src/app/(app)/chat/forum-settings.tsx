"use client";

/**
 * A forum's own settings, inside its channel settings: the guidelines shown
 * above the posts, whether a post must carry a tag, and the tags themselves.
 * Each change is saved on its own and drawn at once, and put back with the
 * refusal if the server says no.
 */

import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton,
    Switch,
    Textarea
} from "@polaris/ui";
import type { ChatForumTagView, ChatForumView } from "@/lib/chat/forum";
import {
    createForumTagAction,
    deleteForumTagAction,
    readForumAction,
    renameForumTagAction,
    updateForumSettingsAction
} from "./forum-actions";

export function ForumSettings({ channelId }: { channelId: string }) {
    const t = useTranslations("chat");
    const [forum, setForum] = useState<ChatForumView | null>(null);
    const [guidelines, setGuidelines] = useState("");
    const [saving, setSaving] = useState(false);
    const [newTag, setNewTag] = useState("");
    const [addingTag, setAddingTag] = useState(false);
    const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        void readForumAction(channelId).then((result) => {
            if (!live) return;
            if (result.forum) {
                setForum(result.forum);
                setGuidelines(result.forum.guidelines);
            } else setError(result.error ?? "");
        });
        return () => {
            live = false;
        };
    }, [channelId]);

    if (!forum) {
        return (
            <div className="flex flex-col gap-3" aria-hidden>
                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : (
                    <>
                        <Skeleton className="h-20 w-full" />
                        <Skeleton className="h-9 w-1/2" />
                    </>
                )}
            </div>
        );
    }

    const setTags = (tags: readonly ChatForumTagView[]) => setForum({ ...forum, tags });
    const guidelinesDirty = guidelines.trim() !== forum.guidelines;
    const tooLong = guidelines.length > core.MAX_FORUM_GUIDELINES;
    const newTagName = newTag.trim();

    const saveGuidelines = async () => {
        setSaving(true);
        const result = await updateForumSettingsAction({ channelId, guidelines });
        setSaving(false);
        if (result.error) return setError(result.error);
        setError("");
        setForum({ ...forum, guidelines: guidelines.trim() });
    };

    const toggleRequire = async (requireTag: boolean) => {
        const before = forum;
        setForum({ ...forum, requireTag });
        const result = await updateForumSettingsAction({ channelId, requireTag });
        if (result.error) {
            setForum(before);
            setError(result.error);
        } else setError("");
    };

    const addTag = async () => {
        if (!newTagName) return;
        const before = forum.tags;
        const placeholder = { id: `pending-${newTagName}`, name: newTagName };
        setTags([...before, placeholder]);
        setNewTag("");
        setAddingTag(false);
        const result = await createForumTagAction({ channelId, name: newTagName });
        if (!result.tag) {
            setTags(before);
            setNewTag(newTagName);
            return setError(result.error ?? "");
        }
        setError("");
        setTags([...before, result.tag]);
    };

    const rename = async () => {
        if (!editing) return;
        const name = editing.name.trim();
        const before = forum.tags;
        const current = before.find((tag) => tag.id === editing.id);
        setEditing(null);
        if (!name || current?.name === name) return;
        setTags(before.map((tag) => (tag.id === editing.id ? { ...tag, name } : tag)));
        const result = await renameForumTagAction({ tagId: editing.id, name });
        if (result.error) {
            setTags(before);
            setError(result.error);
        } else setError("");
    };

    const remove = async (id: string) => {
        const before = forum.tags;
        setTags(before.filter((tag) => tag.id !== id));
        const result = await deleteForumTagAction(id);
        if (result.error) {
            setTags(before);
            setError(result.error);
        } else setError("");
    };

    return (
        <section aria-labelledby="forum-settings" className="flex flex-col gap-4">
            <h2 id="forum-settings" className="text-sm font-semibold">
                {t("forum.settingsTitle")}
            </h2>

            <div className="flex flex-col gap-1.5">
                <label
                    htmlFor="forum-guidelines"
                    className="text-[0.75rem] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                    {t("forum.guidelines")}
                </label>
                <Textarea
                    id="forum-guidelines"
                    value={guidelines}
                    rows={4}
                    placeholder={t("forum.guidelinesPlaceholder")}
                    aria-invalid={tooLong ? true : undefined}
                    onChange={(event) => setGuidelines(event.target.value)}
                />
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className={tooLong ? "text-danger tabular-nums" : "tabular-nums"}>
                        {t("channelSettings.count", {
                            count: guidelines.length,
                            max: core.MAX_FORUM_GUIDELINES
                        })}
                    </span>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={!guidelinesDirty || tooLong || saving}
                        onClick={() => void saveGuidelines()}
                    >
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        {t("forum.saveGuidelines")}
                    </Button>
                </div>
            </div>

            <label className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{t("forum.requireTag")}</span>
                    <span className="text-xs text-muted-foreground">{t("forum.requireTagHint")}</span>
                </span>
                <Switch
                    checked={forum.requireTag}
                    onChange={(on) => void toggleRequire(on)}
                    disabled={!forum.requireTag && forum.tags.length === 0}
                    aria-label={t("forum.requireTag")}
                />
            </label>

            <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("forum.tags")}
                    </p>
                    <Button
                        size="sm"
                        disabled={forum.tags.length >= core.MAX_FORUM_TAGS}
                        title={forum.tags.length >= core.MAX_FORUM_TAGS ? t("forum.tagsFull") : undefined}
                        onClick={() => setAddingTag(true)}
                    >
                        <Plus className="size-4" />
                        {t("forum.addTag")}
                    </Button>
                </div>
                {forum.tags.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t("forum.noTagsYet")}</p>
                )}
                <ul className="flex flex-col gap-1">
                    {forum.tags.map((tag) => (
                        <li key={tag.id} className="flex min-w-0 items-center gap-2">
                            {editing?.id === tag.id ? (
                                <>
                                    <Input
                                        value={editing.name}
                                        maxLength={core.MAX_FORUM_TAG}
                                        aria-label={t("forum.tagName")}
                                        autoFocus
                                        onChange={(event) => setEditing({ id: tag.id, name: event.target.value })}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") void rename();
                                            if (event.key === "Escape") setEditing(null);
                                        }}
                                    />
                                    <Button size="icon" variant="ghost" aria-label={t("forum.saveTag")} onClick={() => void rename()}>
                                        <Check className="size-4" />
                                    </Button>
                                    <Button size="icon" variant="ghost" aria-label={t("newChannel.cancel")} onClick={() => setEditing(null)}>
                                        <X className="size-4" />
                                    </Button>
                                </>
                            ) : (
                                <>
                                    <span className="min-w-0 flex-1 truncate text-sm" title={tag.name}>
                                        {tag.name}
                                    </span>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("forum.renameTag", { name: tag.name })}
                                        disabled={tag.id.startsWith("pending-")}
                                        onClick={() => setEditing({ id: tag.id, name: tag.name })}
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("forum.deleteTag", { name: tag.name })}
                                        disabled={tag.id.startsWith("pending-")}
                                        onClick={() => void remove(tag.id)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            </div>

            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}

            <Dialog open={addingTag} onOpenChange={setAddingTag}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("forum.addTagTitle")}</DialogTitle>
                        <DialogDescription>{t("forum.addTagDescription")}</DialogDescription>
                    </DialogHeader>
                    <form
                        className="flex flex-col gap-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void addTag();
                        }}
                    >
                        <Input
                            autoFocus
                            value={newTag}
                            maxLength={core.MAX_FORUM_TAG}
                            placeholder={t("forum.newTag")}
                            aria-label={t("forum.newTag")}
                            onChange={(event) => setNewTag(event.target.value)}
                        />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => setAddingTag(false)}>
                                {t("newChannel.cancel")}
                            </Button>
                            <Button type="submit" aria-disabled={!newTagName}>
                                {t("forum.addTag")}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </section>
    );
}
