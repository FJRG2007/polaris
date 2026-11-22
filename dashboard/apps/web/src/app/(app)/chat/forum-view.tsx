"use client";

/**
 * A forum channel's view: the list of its posts instead of a conversation.
 *
 * Each post is a thread root with a title and tags; opening one opens the
 * thread panel every message already has. The list is sorted, searched and
 * narrowed by tag in the database (`lib/chat/forum.ts`), and kept per filter
 * in memory so coming back to the channel draws the last list at once while
 * the fresh one loads behind it.
 *
 * A media channel is the same list drawn as a gallery: each post opens with a
 * picture or a video, and its first one is the tile.
 */

import * as core from "@polaris/core";
import { ImagePlus, Loader2, MessageSquare, Pencil, Play, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Badge,
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    SegmentedControl,
    Skeleton,
    Textarea,
    useToast
} from "@polaris/ui";
import { useChat } from "./chat-context";
import { useChatStream } from "./use-chat-stream";
import { RelativeTime } from "@/components/relative-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { asFiles } from "@/components/file-picker/as-files";
import type { PickedFile } from "@/components/file-picker/picked-file";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { listForumPostsAction, readForumAction, updateForumPostAction } from "./forum-actions";
import type { ChatForumPostView, ChatForumView } from "@/lib/chat/forum";

interface Filter {
    readonly sort: core.ChatForumSort;
    readonly query: string;
    readonly tagId: string | null;
}

interface Listing {
    readonly posts: readonly ChatForumPostView[];
    readonly after: string | null;
}

/** The last list drawn per channel and filter, and the forum's settings. */
const listings = new Map<string, Listing>();
const forums = new Map<string, ChatForumView>();

/** How many pictures and videos one gallery post carries at most. */
const MAX_POST_MEDIA = 10;

function keyOf(channelId: string, filter: Filter): string {
    return `${channelId}|${filter.sort}|${filter.tagId ?? ""}|${filter.query}`;
}

/** Send a new post: its first message through the messages route, with the
 *  title and tags beside it, the same way a message with files goes. */
export async function sendForumPost(input: {
    readonly channelId: string;
    readonly title: string;
    readonly body: string;
    readonly tagIds: readonly string[];
    readonly files?: readonly File[];
}): Promise<{ id?: string; error?: string }> {
    const form = new FormData();
    form.set("body", input.body);
    form.set("forumTitle", input.title);
    form.set("forumTags", JSON.stringify(input.tagIds));
    for (const file of input.files ?? []) form.append("files", file);
    try {
        const response = await fetch(`/api/chat/channels/${input.channelId}/messages`, {
            method: "POST",
            body: form
        });
        const answer = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
        if (!response.ok || !answer.id) return { error: answer.error ?? "" };
        return { id: answer.id };
    } catch {
        return { error: "" };
    }
}

export function ForumView({
    channelId,
    media = false,
    canPost,
    onOpenPost
}: {
    channelId: string;
    /** Draw the posts as a gallery, and ask for a picture or video on each. */
    media?: boolean;
    canPost: boolean;
    onOpenPost: (root: ChatMessageView) => void;
}) {
    const t = useTranslations("chat");
    const [typed, setTyped] = useState("");
    const [filter, setFilter] = useState<Filter>({ sort: "activity", query: "", tagId: null });
    const key = keyOf(channelId, filter);
    const [listing, setListing] = useState<Listing | null>(() => listings.get(key) ?? null);
    const [forum, setForum] = useState<ChatForumView | null>(() => forums.get(channelId) ?? null);
    const [error, setError] = useState("");
    const [loadingMore, setLoadingMore] = useState(false);
    const [composing, setComposing] = useState(false);
    const [pending, setPending] = useState<readonly string[]>([]);
    const [editing, setEditing] = useState<ChatForumPostView | null>(null);
    const { viewerId } = useChat();
    const toast = useToast();
    const latest = useRef(key);
    latest.current = key;

    // Typing narrows the list after a pause, not on every key.
    useEffect(() => {
        const timer = setTimeout(() => setFilter((current) => ({ ...current, query: typed.trim() })), 250);
        return () => clearTimeout(timer);
    }, [typed]);

    const loadForum = useCallback(async () => {
        const result = await readForumAction(channelId);
        if (result.forum) {
            forums.set(channelId, result.forum);
            setForum(result.forum);
        }
    }, [channelId]);

    const load = useCallback(async () => {
        const asked = keyOf(channelId, filter);
        const result = await listForumPostsAction({ channelId, ...filter, after: null });
        if (latest.current !== asked) return;
        if (result.error || !result.page) {
            setError(result.error ?? t("forum.couldNotLoad"));
            return;
        }
        setError("");
        listings.set(asked, result.page);
        setListing(result.page);
    }, [channelId, filter, t]);

    useEffect(() => {
        setListing(listings.get(key) ?? null);
        void load();
    }, [key, load]);

    useEffect(() => {
        setForum(forums.get(channelId) ?? null);
        void loadForum();
    }, [channelId, loadForum]);

    /** Put one post's title and tags in the list drawn now and the one kept. */
    const drawPost = useCallback((next: ChatForumPostView) => {
        setListing((current) => {
            if (!current) return current;
            const updated = {
                ...current,
                posts: current.posts.map((post) => (post.id === next.id ? next : post))
            };
            listings.set(latest.current, updated);
            return updated;
        });
    }, []);

    /**
     * A post's new title and tags: drawn at once, put back as they were if the
     * server refuses them, with its reason in a note.
     */
    const saveEdit = useCallback(
        async (before: ChatForumPostView, title: string, tagIds: readonly string[]) => {
            drawPost({ ...before, title, tagIds });
            const result: { error?: string } = await updateForumPostAction({
                postId: before.id,
                title,
                tagIds
            }).catch(() => ({ error: "" }));
            if (result.error === undefined) return;
            drawPost(before);
            toast.show({ title: t("forum.notSaved"), body: result.error || undefined });
        },
        [drawPost, t, toast]
    );

    const editable = (post: ChatForumPostView): boolean =>
        Boolean(forum?.mayManage) || (post.root.authorId !== null && post.root.authorId === viewerId);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "posted" || !frame.channels.includes(channelId)) return;
                void load();
                void loadForum();
            },
            [channelId, load, loadForum]
        )
    );

    const more = async () => {
        if (!listing?.after) return;
        setLoadingMore(true);
        const result = await listForumPostsAction({ channelId, ...filter, after: listing.after });
        setLoadingMore(false);
        if (!result.page) return setError(result.error ?? t("forum.couldNotLoad"));
        const next = { posts: [...listing.posts, ...result.page.posts], after: result.page.after };
        listings.set(key, next);
        setListing(next);
    };

    const tagsById = useMemo(
        () => new Map((forum?.tags ?? []).map((tag) => [tag.id, tag.name])),
        [forum]
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
                {forum?.guidelines && (
                    <section
                        aria-label={t("forum.guidelines")}
                        className="rounded-md bg-muted/60 px-3 py-2 text-sm"
                    >
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t("forum.guidelines")}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words">{forum.guidelines}</p>
                    </section>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-0 flex-1 basis-48">
                        <Search
                            aria-hidden
                            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                        />
                        <Input
                            value={typed}
                            onChange={(event) => setTyped(event.target.value)}
                            placeholder={t("forum.searchPosts")}
                            aria-label={t("forum.searchPosts")}
                            maxLength={core.MAX_FORUM_TITLE}
                            className="ps-8"
                        />
                    </div>
                    <SegmentedControl
                        size="sm"
                        aria-label={t("forum.sortBy")}
                        value={filter.sort}
                        onValueChange={(sort) => setFilter((current) => ({ ...current, sort }))}
                        options={[
                            { value: "activity", label: t("forum.sortActivity") },
                            { value: "created", label: t("forum.sortCreated") }
                        ]}
                    />
                    <Button
                        size="sm"
                        onClick={() => setComposing(true)}
                        disabled={!canPost}
                        title={canPost ? undefined : t("forum.cannotPost")}
                    >
                        <Plus className="size-4" />
                        {t("forum.newPost")}
                    </Button>
                </div>
                {forum && forum.tags.length > 0 && (
                    <div role="group" aria-label={t("forum.filterByTag")} className="flex flex-wrap gap-1.5">
                        {forum.tags.map((tag) => {
                            const on = filter.tagId === tag.id;
                            return (
                                <button
                                    key={tag.id}
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() =>
                                        setFilter((current) => ({ ...current, tagId: on ? null : tag.id }))
                                    }
                                    className={cn(
                                        "max-w-[12rem] truncate rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                                        on
                                            ? "border-primary bg-primary/10 text-foreground"
                                            : "border-border text-muted-foreground hover:bg-card-hover"
                                    )}
                                >
                                    {tag.name}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={listing === null}>
                {error && (
                    <p role="alert" className="px-4 pt-3 text-sm text-danger">
                        {error}
                    </p>
                )}
                {pending.map((title, index) => (
                    <div
                        key={`pending-${index}`}
                        className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm text-muted-foreground"
                    >
                        <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
                        <span className="min-w-0 truncate" title={title}>{title}</span>
                    </div>
                ))}
                {listing === null ? (
                    <div className="flex flex-col gap-3 p-4" aria-hidden>
                        {[0, 1, 2, 3].map((row) => (
                            <Skeleton key={row} className="h-16 w-full" />
                        ))}
                    </div>
                ) : listing.posts.length === 0 && pending.length === 0 ? (
                    <div className="flex h-full items-center justify-center p-6">
                        <EmptyState
                            title={
                                filter.query || filter.tagId
                                    ? t("forum.noMatches")
                                    : media
                                      ? t("forum.noMediaYet")
                                      : t("forum.noPostsYet")
                            }
                            description={
                                filter.query || filter.tagId
                                    ? t("forum.tryAnotherSearch")
                                    : t("forum.startTheFirst")
                            }
                        />
                    </div>
                ) : media ? (
                    <ul className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
                        {listing.posts.map((post) => (
                            <li key={post.id} className="relative min-w-0">
                                <MediaTile post={post} onOpen={() => onOpenPost(post.root)} />
                                {editable(post) && <EditButton onEdit={() => setEditing(post)} />}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <ul className="flex flex-col">
                        {listing.posts.map((post) => (
                            <li key={post.id} className="relative">
                                <PostRow
                                    post={post}
                                    tagsById={tagsById}
                                    onOpen={() => onOpenPost(post.root)}
                                />
                                {editable(post) && <EditButton onEdit={() => setEditing(post)} />}
                            </li>
                        ))}
                    </ul>
                )}
                {listing?.after && (
                    <div className="flex justify-center p-3">
                        <Button variant="ghost" size="sm" onClick={() => void more()} disabled={loadingMore}>
                            {loadingMore && <Loader2 className="size-4 animate-spin" />}
                            {t("forum.showMore")}
                        </Button>
                    </div>
                )}
            </div>

            {editing && forum && (
                <EditPostDialog
                    post={editing}
                    forum={forum}
                    onClose={() => setEditing(null)}
                    onSave={(title, tagIds) => {
                        setEditing(null);
                        void saveEdit(editing, title, tagIds);
                    }}
                />
            )}

            <NewPostDialog
                open={composing}
                onOpenChange={setComposing}
                channelId={channelId}
                forum={forum}
                media={media}
                onSending={(title) => setPending((current) => [title, ...current])}
                onSettled={(title) => {
                    setPending((current) => {
                        const at = current.indexOf(title);
                        return at < 0 ? current : [...current.slice(0, at), ...current.slice(at + 1)];
                    });
                    void load();
                }}
            />
        </div>
    );
}

/** The pencil over a post, for its author and whoever runs the forum. */
function EditButton({ onEdit }: { onEdit: () => void }) {
    const t = useTranslations("chat");
    return (
        <button
            type="button"
            onClick={onEdit}
            aria-label={t("forum.editPost")}
            title={t("forum.editPost")}
            className="absolute end-2 top-2 rounded-md bg-background/80 p-1.5 text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
        >
            <Pencil aria-hidden className="size-3.5 shrink-0" />
        </button>
    );
}

/**
 * A post's title and tags, changed after it was made. Checked with the same
 * schema the server checks the change with, so Save is only offered for one
 * it will take - and only when something differs from what is there.
 */
function EditPostDialog({
    post,
    forum,
    onClose,
    onSave
}: {
    post: ChatForumPostView;
    forum: ChatForumView;
    onClose: () => void;
    onSave: (title: string, tagIds: readonly string[]) => void;
}) {
    const t = useTranslations("chat");
    const [title, setTitle] = useState(post.title);
    // Only the forum's own tags: one deleted since is not offered back.
    const [tagIds, setTagIds] = useState<readonly string[]>(() =>
        post.tagIds.filter((id) => forum.tags.some((tag) => tag.id === id))
    );
    const trimmed = title.trim();
    const valid = core.chatForumPostUpdateSchema.safeParse({
        postId: post.id,
        title: trimmed,
        tagIds: [...tagIds]
    }).success;
    const needsTag = forum.requireTag && tagIds.length === 0;
    const changed =
        trimmed !== post.title ||
        tagIds.length !== post.tagIds.length ||
        tagIds.some((id) => !post.tagIds.includes(id));
    const ready = valid && !needsTag && changed;

    const toggle = (id: string) =>
        setTagIds((current) =>
            current.includes(id)
                ? current.filter((entry) => entry !== id)
                : current.length >= core.MAX_FORUM_POST_TAGS
                  ? current
                  : [...current, id]
        );

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("forum.editPost")}</DialogTitle>
                    <DialogDescription>{t("forum.editPostHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{`${t("forum.postTitle")} *`}</span>
                        <Input
                            value={title}
                            maxLength={core.MAX_FORUM_TITLE}
                            onChange={(event) => setTitle(event.target.value)}
                        />
                    </label>
                    {forum.tags.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {forum.requireTag ? `${t("forum.tags")} *` : t("forum.tags")}
                            </span>
                            <div role="group" aria-label={t("forum.tags")} className="flex flex-wrap gap-1.5">
                                {forum.tags.map((tag) => {
                                    const on = tagIds.includes(tag.id);
                                    return (
                                        <button
                                            key={tag.id}
                                            type="button"
                                            aria-pressed={on}
                                            onClick={() => toggle(tag.id)}
                                            className={cn(
                                                "max-w-[12rem] truncate rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                                                on
                                                    ? "border-primary bg-primary/10"
                                                    : "border-border text-muted-foreground hover:bg-card-hover"
                                            )}
                                        >
                                            {tag.name}
                                        </button>
                                    );
                                })}
                            </div>
                            {needsTag && <p className="text-xs text-muted-foreground">{t("forum.tagRequiredHint")}</p>}
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("newChannel.cancel")}
                    </Button>
                    <Button onClick={() => ready && onSave(trimmed, tagIds)} aria-disabled={!ready} disabled={!ready}>
                        {t("forum.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PostRow({
    post,
    tagsById,
    onOpen
}: {
    post: ChatForumPostView;
    tagsById: ReadonlyMap<string, string>;
    onOpen: () => void;
}) {
    const t = useTranslations("chat");
    const excerpt = plainExcerpt(post.root.body, 160).trim();
    const tags = post.tagIds.flatMap((id) => {
        const name = tagsById.get(id);
        return name ? [{ id, name }] : [];
    });
    return (
        <button
            type="button"
            onClick={onOpen}
            className="flex w-full min-w-0 flex-col gap-1 border-b border-border px-4 py-3 text-start transition-colors hover:bg-card-hover focus-visible:bg-card-hover focus-visible:outline-none"
        >
            <span className="min-w-0 truncate text-sm font-semibold" title={post.title}>
                {post.title}
            </span>
            {tags.length > 0 && (
                <span className="flex min-w-0 flex-wrap gap-1">
                    {tags.map((tag) => (
                        <Badge key={tag.id} variant="neutral" className="max-w-[10rem] truncate">
                            {tag.name}
                        </Badge>
                    ))}
                </span>
            )}
            {excerpt && <span className="line-clamp-2 min-w-0 text-sm text-muted-foreground">{excerpt}</span>}
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{post.root.authorName ?? t("forum.someone")}</span>
                <span className="inline-flex items-center gap-1">
                    <MessageSquare aria-hidden className="size-3.5 shrink-0" />
                    {t("forum.replies", { count: post.root.replyCount })}
                </span>
                <span>
                    {t("forum.lastActivity")} <RelativeTime iso={post.lastActivityAt} />
                </span>
            </span>
        </button>
    );
}

/** One post in a gallery: its first picture or video, the title under it. */
function MediaTile({ post, onOpen }: { post: ChatForumPostView; onOpen: () => void }) {
    const t = useTranslations("chat");
    const file = post.root.attachments.find((entry) => core.isPostMedia(entry.contentType));
    const video = file?.contentType.startsWith("video/") ?? false;
    const still =
        file && (!video || file.hasPoster) ? `/api/chat/attachments/${file.id}${video ? "?poster=1" : ""}` : null;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="group flex w-full min-w-0 flex-col gap-1.5 rounded-lg text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
            <span className="relative block aspect-square w-full overflow-hidden rounded-lg bg-muted">
                {still && (
                    // eslint-disable-next-line @next/next/no-img-element -- a stored file behind its own access check
                    <img
                        src={still}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover transition-transform group-hover:scale-[1.02]"
                    />
                )}
                {video && (
                    <span className="absolute inset-0 flex items-center justify-center">
                        <span className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white">
                            <Play aria-hidden className="size-4 shrink-0" />
                        </span>
                    </span>
                )}
            </span>
            <span className="min-w-0 truncate text-sm font-medium" title={post.title}>
                {post.title}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <MessageSquare aria-hidden className="size-3.5 shrink-0" />
                {t("forum.replies", { count: post.root.replyCount })}
            </span>
        </button>
    );
}

function NewPostDialog({
    open,
    onOpenChange,
    channelId,
    forum,
    media,
    onSending,
    onSettled
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    channelId: string;
    forum: ChatForumView | null;
    media: boolean;
    onSending: (title: string) => void;
    onSettled: (title: string) => void;
}) {
    const t = useTranslations("chat");
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [tagIds, setTagIds] = useState<readonly string[]>([]);
    const [files, setFiles] = useState<readonly File[]>([]);
    const [error, setError] = useState("");
    const tFiles = useTranslations("components");
    const [picking, setPicking] = useState(false);

    const needsTag = Boolean(forum?.requireTag) && tagIds.length === 0;
    // A gallery post is what it shows: the words under it are optional.
    const hasMedia = files.some((file) => core.isPostMedia(file.type));
    const ready = title.trim().length > 0 && !needsTag && (media ? hasMedia : body.trim().length > 0);

    // The shared picker, so a post takes a picture from the machine, a storage
    // or an address like every other attach in Polaris, and opens on Upload.
    const pick = async (picked: readonly PickedFile[]) => {
        const { files: got, failed } = await asFiles(picked, { unreachable: tFiles("files.fetchFailed") });
        if (failed.length > 0) setError(failed[0] ?? "");
        const added = got.filter((file) => core.isPostMedia(file.type));
        setFiles((current) => [...current, ...added].slice(0, MAX_POST_MEDIA));
    };

    const toggle = (id: string) =>
        setTagIds((current) =>
            current.includes(id)
                ? current.filter((entry) => entry !== id)
                : current.length >= core.MAX_FORUM_POST_TAGS
                  ? current
                  : [...current, id]
        );

    const submit = async () => {
        if (!ready) return;
        const draft = { title: title.trim(), body, tagIds, files };
        // Shown in the list at once; the dialog comes back with what was typed
        // if the post is refused.
        onSending(draft.title);
        onOpenChange(false);
        const result = await sendForumPost({ channelId, ...draft });
        onSettled(draft.title);
        if (result.error !== undefined) {
            setError(result.error || t("forum.notPosted"));
            onOpenChange(true);
            return;
        }
        setTitle("");
        setBody("");
        setTagIds([]);
        setFiles([]);
        setError("");
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("forum.newPost")}</DialogTitle>
                    <DialogDescription>{t("forum.newPostHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("forum.postTitle")} *</span>
                        <Input
                            value={title}
                            maxLength={core.MAX_FORUM_TITLE}
                            onChange={(event) => setTitle(event.target.value)}
                            autoFocus
                        />
                    </label>
                    {media && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">{t("forum.media")} *</span>
                            {picking && (
                                <FilePickerDialog
                                    title={t("forum.addMedia")}
                                    accept="image/*,video/*"
                                    onClose={() => setPicking(false)}
                                    onPick={(picked) => void pick(picked)}
                                />
                            )}
                            {files.length > 0 && (
                                <ul className="flex flex-col gap-1">
                                    {files.map((file, index) => (
                                        <li
                                            key={`${file.name}-${index}`}
                                            className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
                                        >
                                            <span className="min-w-0 flex-1 truncate" title={file.name}>
                                                {file.name}
                                            </span>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t("forum.removeMedia", { name: file.name })}
                                                onClick={() =>
                                                    setFiles((current) => current.filter((_, at) => at !== index))
                                                }
                                            >
                                                <X className="size-4 shrink-0" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {files.length < MAX_POST_MEDIA && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="self-start"
                                    onClick={() => setPicking(true)}
                                >
                                    <ImagePlus className="size-4 shrink-0" />
                                    {t("forum.addMedia")}
                                </Button>
                            )}
                            <p className="text-xs text-muted-foreground">{t("forum.mediaHint")}</p>
                        </div>
                    )}
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                            {media ? t("forum.caption") : `${t("forum.firstMessage")} *`}
                        </span>
                        <Textarea
                            value={body}
                            rows={5}
                            maxLength={core.MAX_CHAT_MESSAGE}
                            onChange={(event) => setBody(event.target.value)}
                        />
                    </label>
                    {forum && forum.tags.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {forum.requireTag ? `${t("forum.tags")} *` : t("forum.tags")}
                            </span>
                            <div role="group" aria-label={t("forum.tags")} className="flex flex-wrap gap-1.5">
                                {forum.tags.map((tag) => {
                                    const on = tagIds.includes(tag.id);
                                    return (
                                        <button
                                            key={tag.id}
                                            type="button"
                                            aria-pressed={on}
                                            onClick={() => toggle(tag.id)}
                                            className={cn(
                                                "max-w-[12rem] truncate rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                                                on
                                                    ? "border-primary bg-primary/10"
                                                    : "border-border text-muted-foreground hover:bg-card-hover"
                                            )}
                                        >
                                            {tag.name}
                                        </button>
                                    );
                                })}
                            </div>
                            {forum.requireTag && (
                                <p className="text-xs text-muted-foreground">{t("forum.tagRequiredHint")}</p>
                            )}
                        </div>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("newChannel.cancel")}
                    </Button>
                    <Button onClick={() => void submit()} aria-disabled={!ready} disabled={!ready}>
                        {t("forum.post")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
