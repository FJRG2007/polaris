"use client";

/**
 * The conversation list, for whichever space the rail is standing in.
 *
 * One space deep at a time rather than every space at once. A rail that listed
 * six spaces with their channels expanded under each was a rail nobody could see
 * the bottom of, and the thing people actually do is work in one place for an
 * hour at a time.
 *
 * Inside a space the channels sit under their headings in the order they were
 * made, so the list does not rearrange itself while somebody is reading it - a
 * rail that reorders on every message is a rail you cannot learn. Direct
 * messages are the exception and are ordered by what happened last, because
 * there is no other order a list of people has.
 *
 * A conversation with something unread is bold and carries a count. That is the
 * whole treatment: no colour, no dot as well as a number, and nothing that moves.
 *
 * A voice room lists who is in it. A count would not answer the question anybody
 * is asking, which is not "how many" but "is anyone I want to talk to in there".
 */

import Link from "next/link";
import * as actions from "./actions";
import { useChat } from "./chat-context";
import { Elsewhere } from "./elsewhere";
import { usePresence } from "@/components/presence-store";
import { presenceLine } from "@/components/activity-card";
import { rememberChannel } from "./recents";
import { Avatar } from "@/components/avatar";
import { RelativeTime } from "@/components/relative-time";
import { channelLink, copyText } from "./links";
import { openSearch } from "@/lib/search/open-search";
import { useAppUrl } from "@/components/app-url";
import { ChatAvatar } from "@/components/chat-avatar";
import { NewDirectDialog } from "./new-direct-dialog";
import * as core from "@polaris/core";
import { LiveBadge, VoiceStateIcons } from "./call-roster";
import { ModerationItems } from "./call-moderation-menu";
import { useChatStream } from "./use-chat-stream";
import { NewChannelDialog } from "./new-channel-dialog";
import { PersonName, PersonRow } from "@/components/person-name";
import { useParams, usePathname, useRouter } from "next/navigation";
import type { VoicePresence } from "@/lib/chat/meetings";
import { NotifyOptions } from "./notify-menu";
import { GameLinkMark } from "./game-link-badge";
import { blockPersonAction, unblockPersonAction } from "@/app/(app)/account/privacy/actions";
import { MuteOptions, type MenuParts } from "./mute-menu";
import { LeaveDialog } from "./leave-dialog";
import { runAction } from "@/lib/run-action";
import { NicknameDialog } from "./nickname-dialog";
import { ChannelSettingsDialog } from "./channel-settings-dialog";
import { DuplicateChannelDialog } from "./duplicate-channel-dialog";
import { InviteDialog } from "./invite-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatChannelView, ChatSpaceView } from "@/lib/chat/chat-service";
import { reordered, useRailDrag, type Dragging, type DropTarget } from "./use-rail-drag";
import {
    Ban,
    CheckCheck,
    ChevronDown,
    ChevronsDownUp,
    ChevronsUpDown,
    Copy,
    Fingerprint,
    FolderPlus,
    Hash,
    Link2,
    Lock,
    LogOut,
    Mail,
    MessageSquarePlus,
    Pencil,
    Phone,
    Pin,
    PinOff,
    Plus,
    Search,
    Settings2,
    ShieldOff,
    Star,
    Trash2,
    UserPlus,
    Video,
    Volume2,
    X
} from "lucide-react";
import {
    Button,
    cn,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Skeleton
} from "@polaris/ui";

/** How the shared mute list draws itself inside a right-click menu. */
const CONTEXT_PARTS: MenuParts = {
    Item: ContextMenuItem,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent
};

/** What an administrator's right-click on a channel asks the rail to open. */
type ChannelManage = "edit" | "duplicate" | "create" | "delete";

/** How often the rail asks who is sitting in the voice rooms. Often enough that
 *  somebody walking in appears while you are looking at it, rarely enough that a
 *  rail left open all day is not a request every second. */
const PRESENCE_EVERY_MS = 8000;

export function ChatSidebar() {
    const { channels, spaces, categories, activeSpaceId, setActiveSpaceId, refresh, loaded } =
        useChat();
    const params = useParams<{ channelId?: string }>();
    const open = params.channelId ?? null;
    const here = usePathname();
    const saved = here === "/chat/saved";
    const meetings = here.startsWith("/chat/meetings");

    const [folded, setFolded] = useState<readonly string[]>([]);
    const [newDirect, setNewDirect] = useState(false);
    const [newChannelIn, setNewChannelIn] = useState<{
        space: ChatSpaceView;
        categoryId: string | null;
    } | null>(null);
    const [newCategory, setNewCategory] = useState(false);
    const [categoryName, setCategoryName] = useState("");
    const [error, setError] = useState("");
    const [managing, setManaging] = useState<ChatChannelView | null>(null);
    const [duplicating, setDuplicating] = useState<ChatChannelView | null>(null);
    const [deleting, setDeleting] = useState<ChatChannelView | null>(null);
    const [deleteError, setDeleteError] = useState("");
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
    const [inRoom, setInRoom] = useState<Record<string, VoicePresence[]>>({});

    const space = useMemo(
        () => spaces.find((entry) => entry.id === activeSpaceId) ?? null,
        [spaces, activeSpaceId]
    );

    // Opening a conversation moves the rail to where it lives. Without this,
    // following a link to a channel would leave the column pointing somewhere
    // else and the list beside it showing a different space.
    useEffect(() => {
        if (!open) return;
        const channel = channels.find((entry) => entry.id === open);
        if (!channel) return;
        setActiveSpaceId(channel.spaceId);
        // And remembered, so choosing this space again on this browser comes back
        // here rather than to whatever is at the top of the list. Direct messages
        // are remembered the same way, under a key of their own.
        rememberChannel(channel.spaceId, channel.id);
    }, [open, channels, setActiveSpaceId]);

    // Pinned first, then whatever happened most recently. Pinning is why the
    // list is not simply sorted by time: the point of it is a conversation that
    // stays where somebody put it even on a day nobody says anything in it.
    const directs = useMemo(
        () =>
            channels
                .filter((channel) => channel.spaceId === null)
                .sort(
                    (left, right) =>
                        Number(right.pinned) - Number(left.pinned) ||
                        (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
                ),
        [channels]
    );

    const inSpace = useMemo(
        () =>
            activeSpaceId
                ? channels.filter(
                      (channel) => channel.spaceId === activeSpaceId && !channel.archived
                  )
                : [],
        [channels, activeSpaceId]
    );

    const voiceIds = useMemo(
        () => inSpace.filter((channel) => channel.kind === "voice").map((channel) => channel.id),
        [inSpace]
    );

    const readPresence = useCallback(() => {
        if (voiceIds.length === 0) {
            setInRoom({});
            return;
        }
        void actions
            .voicePresenceAction(voiceIds)
            .then((result) => setInRoom(result.inRoom))
            .catch(() => undefined);
    }, [voiceIds]);

    // Somebody walking into a room, leaving it or muting is announced, so the
    // names under it follow at once rather than at the next poll.
    useChatStream((frame) => {
        if (frame.kind === "call" && voiceIds.includes(frame.channelId)) readPresence();
    });

    useEffect(() => {
        readPresence();
        if (voiceIds.length === 0) return;
        const timer = setInterval(readPresence, PRESENCE_EVERY_MS);
        return () => clearInterval(timer);
    }, [readPresence, voiceIds.length]);

    const manages = space !== null && space.access !== "member";
    const t = useTranslations("chat");
    const tc = useTranslations("common");
    const router = useRouter();

    const manage = useCallback(
        (channel: ChatChannelView, action: ChannelManage) => {
            if (action === "edit") setManaging(channel);
            else if (action === "duplicate") setDuplicating(channel);
            else if (action === "delete") {
                setDeleteError("");
                setDeleting(channel);
            } else if (space) setNewChannelIn({ space, categoryId: channel.categoryId });
        },
        [space]
    );

    /**
     * A drag ended.
     *
     * The rail rebuilds the list it just drew and sends the whole thing, so the
     * stored order is the order somebody was looking at. Nothing is drawn
     * optimistically: the write is one small statement and the rail is told
     * about it, and a rail that moved and then moved back would be worse than
     * one that moves a moment late.
     */
    const drag = useRailDrag({
        enabled: manages,
        onDrop: useCallback(
            (source: Dragging, target: DropTarget) => {
                if (!space) return;
                if (source.kind === "category") {
                    const ids = categories
                        .filter((entry) => entry.spaceId === space.id)
                        .map((entry) => entry.id);
                    void actions
                        .reorderCategoriesAction({
                            spaceId: space.id,
                            categoryIds: reordered(ids, source.id, target)
                        })
                        .then((result) => setError(result.error ?? ""))
                        .then(refresh);
                    return;
                }

                // Which heading it landed under: the one it was dropped past the
                // end of, or the one holding the row it was dropped on.
                const landedIn =
                    target.at === "end"
                        ? target.categoryId
                        : (channels.find((entry) => entry.id === target.id)?.categoryId ?? null);
                const ids = channels
                    .filter(
                        (entry) =>
                            entry.spaceId === space.id &&
                            entry.categoryId === landedIn &&
                            !entry.archived
                    )
                    .map((entry) => entry.id);
                void actions
                    .reorderChannelsAction({
                        spaceId: space.id,
                        categoryId: landedIn,
                        channelIds: reordered(ids, source.id, target)
                    })
                    .then((result) => setError(result.error ?? ""))
                    .then(refresh);
            },
            [categories, channels, refresh, space]
        )
    });

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-header shrink-0 items-center justify-between gap-2 border-b border-border px-3">
                <span className="min-w-0 truncate text-sm font-semibold" title={space?.name}>
                    {space?.name ?? t("sidebar.directMessages")}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                    {space === null ? (
                        <button
                            type="button"
                            aria-label={t("sidebar.startADirectMessage")}
                            title={t("sidebar.startADirectMessage")}
                            onClick={() => setNewDirect(true)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <MessageSquarePlus className="size-4" />
                        </button>
                    ) : (
                        manages && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label={t("sidebar.addTo", { name: space.name })}
                                        title={t("sidebar.addAChannelOrA")}
                                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <Plus className="size-4" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            setNewChannelIn({ space, categoryId: null })
                                        }
                                    >
                                        <Hash className="size-3.5" />
                                        {t("sidebar.newChannel")}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onSelect={() => setNewCategory(true)}>
                                        <FolderPlus className="size-3.5" />
                                        {t("sidebar.newCategory")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )
                    )}
                </div>
            </div>

            {/* The quick switcher, where a chat app keeps it: above the list,
                opening the same panel as Ctrl+K already narrowed to Chat -
                people, conversations, channels and messages. */}
            <div className="shrink-0 px-2 pt-2">
                <button
                    type="button"
                    onClick={() => openSearch("chat")}
                    aria-label={t("sidebar.findOrStartAConversation")}
                    aria-keyshortcuts="Control+K Meta+K"
                    className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-field px-2 text-left text-sm text-foreground-subtle transition-colors hover:border-border-strong hover:text-muted-foreground"
                >
                    <Search className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{t("sidebar.findOrStartAConversation")}</span>
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
                {/* In every rail rather than only above the direct messages.
                    What somebody kept is theirs, not a space's, and a list that
                    disappears when you walk into a server is a list people
                    conclude does not exist. */}
                <Link
                    href="/chat/saved"
                    className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-card-hover",
                        saved ? "bg-card-hover text-foreground" : "text-muted-foreground"
                    )}
                >
                    <Star className="size-3.5 shrink-0" />
                    <span>{t("sidebar.savedMessages")}</span>
                </Link>

                {/* In every rail for the same reason, and drawn for everybody:
                    creating a meeting takes a grant, being invited to one does
                    not, and somebody who has been invited needs the list far
                    more than the person who made it. */}
                <Link
                    href="/chat/meetings"
                    className={cn(
                        "mb-3 flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-card-hover",
                        meetings ? "bg-card-hover text-foreground" : "text-muted-foreground"
                    )}
                >
                    <Video className="size-3.5 shrink-0" />
                    <span>{t("sidebar.meetings")}</span>
                </Link>

                {error && (
                    <p role="alert" className="px-1 pb-2 text-xs text-danger">
                        {error}
                    </p>
                )}

                {!loaded ? (
                    <SidebarSkeleton />
                ) : space === null ? (
                    <Section
                        label={t("sidebar.directMessages")}
                        folded={folded.includes("dm")}
                        onToggle={() => toggle("dm")}
                    >
                        {directs.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-foreground-subtle">{t("sidebar.nobodyYet")}</p>
                        ) : (
                            directs.map((channel) => (
                                <Row
                                    key={channel.id}
                                    channel={channel}
                                    roomy
                                    href={`/chat/c/${channel.id}`}
                                    active={open === channel.id}
                                    unread={channel.unread}
                                    muted={channel.muted}
                                    label={channel.name}
                                    personId={
                                        channel.others.length === 1
                                            ? (channel.others[0]?.id ?? null)
                                            : null
                                    }
                                    icon={
                                        channel.others.length === 1 && channel.others[0] ? (
                                            // Twenty rather than eighteen, which
                                            // is the size below which a face goes
                                            // without its presence dot - so this
                                            // list was the one place in Polaris
                                            // where somebody's face did not say
                                            // whether they were there.
                                            <PhoneSized
                                                small={
                                                    <Avatar
                                                        decorated
                                                        person={channel.others[0]}
                                                        size={24}
                                                    />
                                                }
                                                large={
                                                    <Avatar
                                                        decorated
                                                        person={channel.others[0]}
                                                        size={40}
                                                    />
                                                }
                                            />
                                        ) : (
                                            // A group is its picture, or the
                                            // faces of the people in it. An
                                            // icon shared by every group is
                                            // the one thing that cannot tell
                                            // two of them apart.
                                            <PhoneSized
                                                small={
                                                    <ChatAvatar
                                                        kind="channel"
                                                        id={channel.id}
                                                        name={channel.name}
                                                        members={channel.others}
                                                        size={24}
                                                    />
                                                }
                                                large={
                                                    <ChatAvatar
                                                        kind="channel"
                                                        id={channel.id}
                                                        name={channel.name}
                                                        members={channel.others}
                                                        size={40}
                                                    />
                                                }
                                            />
                                        )
                                    }
                                />
                            ))
                        )}
                        {/* Under the list rather than above it: it is an
                            account of what the badge counts and this list does
                            not, and nobody comes to the rail looking for it. */}
                        <Elsewhere revision={channels} />
                    </Section>
                ) : (
                    <>
                        {/* Above the first heading: the channels that belong to
                            no category, drawn without one rather than under an
                            invented "General".

                            The strip stays even with nothing in it, because it
                            is where a channel goes to belong to no heading -
                            without it there was nowhere to drop one. */}
                        <div
                            {...(manages ? drag.areaProps(null) : {})}
                            className={cn(
                                "mb-1 min-h-2 rounded-md ring-1 ring-inset transition-colors duration-fast",
                                drag.dropInto && drag.dropInto.categoryId === null
                                    ? "bg-primary/5 ring-primary/40"
                                    : "ring-transparent"
                            )}
                        >
                            <ChannelRows
                                channels={inSpace.filter((channel) => channel.categoryId === null)}
                                open={open}
                                inRoom={inRoom}
                                onModerated={readPresence}
                                drag={drag}
                                manages={manages}
                                onManage={manage}
                            />
                        </div>

                        {categories
                            .filter((category) => category.spaceId === space.id)
                            .map((category) => (
                                <Section
                                    key={category.id}
                                    label={category.name}
                                    folded={folded.includes(category.id)}
                                    onToggle={() => toggle(category.id)}
                                    handle={
                                        manages
                                            ? {
                                                  ...drag.handleProps({
                                                      kind: "category",
                                                      id: category.id
                                                  }),
                                                  ...drag.rowProps("category", category.id)
                                              }
                                            : undefined
                                    }
                                    dropping={
                                        drag.dropAt?.kind === "category" &&
                                        drag.dropAt.id === category.id
                                            ? drag.dropAt.after
                                                ? "after"
                                                : "before"
                                            : null
                                    }
                                    area={manages ? drag.areaProps(category.id) : undefined}
                                    into={drag.dropInto?.categoryId === category.id}
                                    menu={
                                        <CategoryMenuItems
                                            folded={folded.includes(category.id)}
                                            unread={inSpace.some(
                                                (channel) =>
                                                    channel.categoryId === category.id &&
                                                    channel.unread > 0
                                            )}
                                            onMarkRead={async () => {
                                                const ids = inSpace
                                                    .filter(
                                                        (channel) =>
                                                            channel.categoryId === category.id &&
                                                            channel.unread > 0
                                                    )
                                                    .map((channel) => channel.id);
                                                const result = await actions.markChannelsReadAction({
                                                    channelIds: ids
                                                });
                                                setError(result.error ?? "");
                                                refresh();
                                            }}
                                            onToggle={() => toggle(category.id)}
                                            onFoldAll={(fold) =>
                                                setFolded(
                                                    fold
                                                        ? categories
                                                              .filter(
                                                                  (entry) => entry.spaceId === space.id
                                                              )
                                                              .map((entry) => entry.id)
                                                        : []
                                                )
                                            }
                                            manage={
                                                manages
                                                    ? {
                                                          onCreate: () =>
                                                              setNewChannelIn({
                                                                  space,
                                                                  categoryId: category.id
                                                              }),
                                                          onRename: () =>
                                                              setRenaming({
                                                                  id: category.id,
                                                                  name: category.name
                                                              }),
                                                          onDelete: async () => {
                                                              const result =
                                                                  await actions.deleteCategoryAction(
                                                                      category.id
                                                                  );
                                                              setError(result.error ?? "");
                                                          }
                                                      }
                                                    : null
                                            }
                                        />
                                    }
                                    action={
                                        manages ? (
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <button
                                                        type="button"
                                                        aria-label={t("sidebar.moreFor", { name: category.name })}
                                                        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                                                    >
                                                        <Plus className="size-3.5" />
                                                    </button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem
                                                        onSelect={() =>
                                                            setNewChannelIn({
                                                                space,
                                                                categoryId: category.id
                                                            })
                                                        }
                                                    >
                                                        <Hash className="size-3.5" />
                                                        {t("sidebar.newChannelHere")}
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        variant="danger"
                                                        onSelect={async () => {
                                                            const result =
                                                                await actions.deleteCategoryAction(
                                                                    category.id
                                                                );
                                                            setError(result.error ?? "");
                                                        }}
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                        {t("sidebar.deleteCategory")}
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        ) : null
                                    }
                                >
                                    <ChannelRows
                                        channels={inSpace.filter(
                                            (channel) => channel.categoryId === category.id
                                        )}
                                        open={open}
                                        inRoom={inRoom}
                                        onModerated={readPresence}
                                        drag={drag}
                                        manages={manages}
                                        onManage={manage}
                                        empty="Nothing here yet."
                                    />
                                </Section>
                            ))}

                        {inSpace.length === 0 && (
                            <p className="px-2 py-3 text-xs text-muted-foreground">
                                {t("sidebar.noChannelsYet")}
                            </p>
                        )}
                    </>
                )}
            </div>

            <ChannelSettingsDialog
                channel={managing}
                onOpenChange={(next) => !next && setManaging(null)}
            />
            <DuplicateChannelDialog
                channel={duplicating}
                onOpenChange={(next) => !next && setDuplicating(null)}
            />
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(next) => !next && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="channel"
                title={t("channelMenu.deleteTitle")}
                description={t("channelMenu.deleteHint")}
                confirmLabel={t("channelMenu.delete")}
                error={deleteError}
                onConfirm={async () => {
                    if (!deleting) return;
                    const gone = deleting;
                    const result = await runAction(
                        () => actions.deleteChannelAction(gone.id),
                        setDeleteError
                    );
                    if (!result || result.error) {
                        if (result?.error) setDeleteError(result.error);
                        return;
                    }
                    setDeleting(null);
                    refresh();
                    // Only when it is the room on screen: deleting another one
                    // from the list must not throw the reader out of this one.
                    if (open === gone.id) router.push("/chat");
                }}
            />
            <Dialog open={renaming !== null} onOpenChange={(next) => !next && setRenaming(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("channelMenu.editCategory")}</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={renaming?.name ?? ""}
                        autoFocus
                        aria-label={t("channelMenu.categoryName")}
                        maxLength={core.MAX_CHAT_CATEGORY_NAME}
                        onChange={(event) =>
                            setRenaming((current) =>
                                current ? { ...current, name: event.target.value } : current
                            )
                        }
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void rename();
                        }}
                    />
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button
                            size="sm"
                            disabled={!renaming?.name.trim()}
                            onClick={() => void rename()}
                        >
                            {tc("actions.save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <NewDirectDialog open={newDirect} onOpenChange={setNewDirect} />
            <NewChannelDialog
                space={newChannelIn?.space ?? null}
                categoryId={newChannelIn?.categoryId ?? null}
                onOpenChange={(next) => !next && setNewChannelIn(null)}
            />

            <Dialog open={newCategory} onOpenChange={setNewCategory}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("sidebar.newCategory")}</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={categoryName}
                        autoFocus
                        placeholder={t("sidebar.whatTheChannelsUnderIt")}
                        aria-label={t("sidebar.whatTheCategoryIsCalled")}
                        onChange={(event) => setCategoryName(event.target.value)}
                    />
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setNewCategory(false)}>
                            {t("sidebar.cancel")}
                        </Button>
                        <Button
                            size="sm"
                            disabled={!categoryName.trim() || !space}
                            onClick={async () => {
                                if (!space) return;
                                const result = await actions.createCategoryAction({
                                    spaceId: space.id,
                                    name: categoryName
                                });
                                setError(result.error ?? "");
                                if (result.error) return;
                                setCategoryName("");
                                setNewCategory(false);
                            }}
                        >
                            {t("sidebar.create")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );

    async function rename(): Promise<void> {
        if (!renaming?.name.trim()) return;
        const result = await actions.renameCategoryAction({
            categoryId: renaming.id,
            name: renaming.name
        });
        setError(result.error ?? "");
        if (result.error) return;
        setRenaming(null);
        refresh();
    }

    function toggle(id: string): void {
        setFolded((current) =>
            current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
        );
    }
}

/** The rows for one group of channels, with whoever is in the voice ones. */
function ChannelRows({
    channels,
    open,
    inRoom,
    drag,
    manages,
    onManage,
    onModerated,
    empty
}: {
    channels: readonly ChatChannelView[];
    open: string | null;
    inRoom: Record<string, VoicePresence[]>;
    /** Called once a moderator's press has been taken, so the names under the
     *  voice rooms redraw with its mark. */
    onModerated?: () => void;
    /** Absent in the direct-message list, which has no order to arrange. */
    drag?: ReturnType<typeof useRailDrag>;
    manages?: boolean;
    onManage?: (channel: ChatChannelView, action: ChannelManage) => void;
    empty?: string;
}) {
    // Dropping into the group rather than between two of its rows is the
    // caller's to hold: it owns the heading, which stays a target while folded
    // and while empty, and this only ever draws what is in it.
    if (channels.length === 0) {
        return empty ? <p className="px-2 py-1 text-xs text-foreground-subtle">{empty}</p> : null;
    }

    return (
        <div className="mb-2 flex flex-col gap-px">
            {channels.map((channel) => {
                const inside = inRoom[channel.id] ?? [];
                const dropping =
                    drag?.dropAt?.kind === "channel" && drag.dropAt.id === channel.id
                        ? drag.dropAt.after
                            ? "after"
                            : "before"
                        : null;
                return (
                    <div
                        key={channel.id}
                        className={cn(
                            "relative transition-opacity duration-fast",
                            drag?.dragging?.id === channel.id && "opacity-40"
                        )}
                        {...(manages && drag
                            ? {
                                  ...drag.handleProps({ kind: "channel", id: channel.id }),
                                  ...drag.rowProps("channel", channel.id)
                              }
                            : {})}
                    >
                        <DropLine shown={dropping === "before"} where="top" />
                        <DropLine shown={dropping === "after"} where="bottom" />
                        <Row
                            channel={channel}
                            // Pressing a voice room's name is how somebody says
                            // they want to be in it, and the room reads that off
                            // the address - see the walk-in in `channel-view`,
                            // which is where the reasoning lives. A text channel
                            // is only ever opened.
                            href={
                                channel.kind === "voice"
                                    ? `/chat/c/${channel.id}?join=1`
                                    : `/chat/c/${channel.id}`
                            }
                            active={open === channel.id}
                            unread={channel.unread}
                            muted={channel.muted}
                            label={channel.name}
                            // How full a limited voice room is, the way every
                            // voice client writes it beside the name.
                            occupancy={
                                channel.kind === "voice"
                                    ? core.voiceOccupancy({
                                          limit: channel.userLimit,
                                          present: inside.length
                                      })
                                    : null
                            }
                            onManage={manages ? onManage : undefined}
                            icon={
                                channel.kind === "voice" ? (
                                    <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
                                ) : channel.private ? (
                                    <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                                ) : (
                                    <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                                )
                            }
                        />
                        {inside.length > 0 && (
                            <ul className="mb-1 ml-7 flex flex-col gap-0.5">
                                {inside.map((person) => (
                                    <VoicePerson
                                        key={person.id}
                                        person={person}
                                        moderates={channel.mayModerate}
                                        onModerated={onModerated}
                                    />
                                ))}
                            </ul>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * Where a dragged row would land.
 *
 * Always in the tree and never conditionally rendered, which is the whole point:
 * an element that appears the instant it is needed cannot be animated into
 * place, and a line that blinks on is one somebody has to look for. This one
 * grows out from the left in the same fast step everything else in the rail
 * moves in, so the eye follows it down the list as the pointer moves.
 *
 * A line rather than a gap that opens: a row moving aside would shift every row
 * under it on every pointer move, and the list would appear to twitch.
 */
function DropLine({ shown, where }: { shown: boolean; where: "top" | "bottom" }) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "pointer-events-none absolute inset-x-2 h-0.5 origin-left rounded-full bg-primary transition-transform duration-fast",
                where === "top" ? "-top-px" : "-bottom-px",
                shown ? "scale-x-100" : "scale-x-0"
            )}
        />
    );
}

function Section({
    label,
    folded,
    onToggle,
    action,
    handle,
    dropping = null,
    area,
    into = false,
    menu,
    children
}: {
    label: string;
    folded: boolean;
    onToggle: () => void;
    action?: React.ReactNode;
    /** What makes the heading itself draggable, when the reader may rearrange
     *  the space. Absent everywhere else. */
    handle?: Record<string, unknown>;
    dropping?: "before" | "after" | null;
    /** What makes the whole heading somewhere a channel can be dropped. On the
     *  outside rather than around the rows, so a folded heading and one with
     *  nothing under it are both targets - which is where a channel is put when
     *  it is being moved into a heading rather than between two rows. */
    area?: Record<string, unknown>;
    /** Whether a channel is being held over it right now. */
    into?: boolean;
    /** What a right-click on the heading offers. */
    menu?: React.ReactNode;
    children: React.ReactNode;
}) {
    const heading = (
            <div {...handle} className="group relative flex items-center gap-1 rounded px-1 data-[state=open]:bg-card-hover">
                <DropLine shown={dropping === "before"} where="top" />
                <DropLine shown={dropping === "after"} where="bottom" />
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={!folded}
                    className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle transition-colors hover:text-foreground"
                >
                    <ChevronDown
                        className={cn(
                            "size-3 shrink-0 transition-transform",
                            folded && "-rotate-90"
                        )}
                    />
                    <span className="truncate" title={label}>
                        {label}
                    </span>
                </button>
                {action}
            </div>
    );
    return (
        <div
            {...area}
            className={cn(
                "mb-3 rounded-md ring-1 ring-inset transition-colors duration-fast",
                into ? "bg-primary/5 ring-primary/40" : "ring-transparent"
            )}
        >
            {menu ? (
                <ContextMenu>
                    <ContextMenuTrigger asChild>{heading}</ContextMenuTrigger>
                    <ContextMenuContent className="w-52">{menu}</ContextMenuContent>
                </ContextMenu>
            ) : (
                heading
            )}
            {!folded && <div className="mt-0.5 flex flex-col gap-px">{children}</div>}
        </div>
    );
}

/**
 * One person sitting in a voice room, under its name in the rail.
 *
 * Right-clicking them is where a moderator mutes, deafens or disconnects them -
 * the rail is where a server's voice rooms are watched from, and nobody should
 * have to join a call to act on it. Offered only to a reader who moderates the
 * channel, and never over their own row: their own buttons do that.
 */
function VoicePerson({
    person,
    moderates,
    onModerated
}: {
    person: VoicePresence;
    moderates: boolean;
    onModerated?: () => void;
}) {
    const { viewerId } = useChat();
    const row = (
        <PersonRow
            as="li"
            personId={person.userId}
            plate="never"
            className="flex items-center gap-1.5 rounded px-1 text-xs text-muted-foreground data-[state=open]:bg-card-hover"
            title={person.name}
        >
            <Avatar
                size={16}
                person={{
                    // A guest has no account behind them, so no picture to ask
                    // for: the initials of the name they gave is all there is.
                    id: person.userId,
                    name: person.name
                }}
            />
            <span className="truncate" title={person.name}>
                <PersonName id={person.userId} name={person.name} />
            </span>
            {person.streaming && <LiveBadge />}
            <VoiceStateIcons person={person} />
        </PersonRow>
    );
    if (!moderates || person.userId === viewerId) return row;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent className="w-52">
                <ContextMenuLabel className="truncate">{person.name}</ContextMenuLabel>
                <ModerationItems
                    name={person.name}
                    seat={{
                        participantId: person.id,
                        restriction: {
                            serverMuted: person.serverMuted,
                            serverDeafened: person.serverDeafened
                        },
                        onDone: onModerated
                    }}
                />
            </ContextMenuContent>
        </ContextMenu>
    );
}

function Row({
    href,
    active,
    unread,
    muted,
    label,
    icon,
    personId,
    channel,
    onManage,
    occupancy = null,
    roomy = false
}: {
    href: string;
    active: boolean;
    unread: number;
    muted: boolean;
    label: string;
    icon: React.ReactNode;
    /** How many are in a limited voice room over how many it holds, or null. */
    occupancy?: string | null;
    /**
     * Whose conversation it is, for a direct message with one other person.
     *
     * The label of such a row IS somebody's name, so it wears what they chose:
     * their plate behind the row and their colours across the letters. Absent on
     * a group, a channel or the link to what you saved - a plate belongs to a
     * person, and a room of four has no one person to take it from.
     */
    personId?: string | null;
    /** What a right-click acts on. Absent on the rows that are not a
     *  conversation, such as the link to what somebody has saved. */
    channel?: ChatChannelView;
    /** Present for somebody who administers the space, so the menu can offer
     *  what only they may do. */
    onManage?: (channel: ChatChannelView, action: ChannelManage) => void;
    /**
     * Drawn large on a phone, the way a messenger lists its conversations: a
     * bigger face, a bigger name, and when the last message was. On a phone the
     * list is the whole screen and is worked with a thumb; the compact row is a
     * desktop rail's, and from `md` up that is exactly what this still draws.
     */
    roomy?: boolean;
}) {
    const t = useTranslations("chat");
    // A muted conversation still counts its messages - it just does not shout
    // about them, which is the difference between muting and leaving.
    const shout = unread > 0 && !muted;
    /**
     * What they have said they are doing, under their name.
     *
     * Only on a row that is one person - a group of four has no one status to
     * show - and only while they are actually here, which the presence store
     * already decides: a note under a grey dot is a line from a day that is
     * over. Truncated rather than wrapped, because the rail is narrow and a row
     * that grows to three lines pushes the conversation below it off the screen.
     */
    // Or, when they said nothing, what they are playing or listening to.
    const said = presenceLine(usePresence(personId), useTranslations("components"));
    const row = (
        <PersonRow
            as={Link}
            personId={personId}
            href={href}
            // Held back until this is the row under the pointer or the
            // conversation that is open. A gradient behind every row down a
            // column of thirty makes the column unreadable and paints over the
            // marks that said where you were - so here the plate IS those
            // marks.
            plate="active"
            data-active={active ? "" : undefined}
            className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-card-hover data-[state=open]:bg-card-hover",
                // Every size here has its `md:` twin set back to the line above,
                // so the desktop rail is untouched.
                roomy &&
                    "gap-3 rounded-lg py-2.5 text-[0.9375rem] md:gap-2 md:rounded-md md:py-1.5 md:text-sm",
                active ? "bg-card-hover text-foreground" : "text-muted-foreground",
                shout && "font-medium text-foreground"
            )}
        >
            {icon}
            <span
                className={cn(
                    "flex min-w-0 flex-1 flex-col leading-tight",
                    roomy && "gap-0.5 md:gap-0"
                )}
            >
                <span className="min-w-0 truncate" title={label}>
                    <PersonName id={personId} name={label} />
                </span>
                {said && (
                    <span
                        className={cn(
                            "min-w-0 truncate text-[0.6875rem] text-foreground-subtle",
                            roomy && "text-[0.75rem] md:text-[0.6875rem]"
                        )}
                        title={said}
                    >
                        {said}
                    </span>
                )}
            </span>
            {/* When they last wrote, on a phone only: the rail beside a
                conversation has no room for it, and there the list is not what
                somebody is reading. */}
            {roomy && channel?.lastMessageAt && (
                <RelativeTime
                    iso={channel.lastMessageAt}
                    formatStyle="narrow"
                    className="shrink-0 text-xs text-foreground-subtle md:hidden"
                />
            )}
            {/* A game server talks through this conversation: its call is on
                the server's panel, and members may ask it `/online` here. */}
            {channel && channel.gameLinks.length > 0 && <GameLinkMark links={channel.gameLinks} />}
            {/* Said quietly, and only because a row that sits above a newer
                conversation with nothing to explain it reads as a bug. */}
            {channel?.pinned && (
                <Pin className="size-3 shrink-0 text-foreground-subtle" aria-label={t("sidebar.pinned")} />
            )}
            {occupancy && (
                <span
                    className="shrink-0 rounded bg-muted px-1 text-[0.625rem] font-medium tabular-nums leading-4 text-muted-foreground"
                    aria-label={t("sidebar.placesTaken", { places: occupancy.replace("/", t("sidebar.of")) })}
                    title={t("sidebar.placesTaken", { places: occupancy.replace("/", t("sidebar.of")) })}
                >
                    {occupancy}
                </span>
            )}
            {unread > 0 && (
                <span
                    className={cn(
                        "shrink-0 rounded-full px-1.5 text-[0.625rem] font-medium leading-4",
                        muted
                            ? "bg-muted text-muted-foreground"
                            : "bg-primary text-primary-foreground"
                    )}
                >
                    {unread > 98 ? "99+" : unread}
                </span>
            )}
        </PersonRow>
    );

    return channel ? (
        <RowMenu channel={channel} onManage={onManage}>
            {row}
        </RowMenu>
    ) : (
        row
    );
}

/**
 * One of two renderings by screen width: `large` below `md`, `small` from it.
 *
 * For the faces in the direct-message list, whose size is a number the avatar
 * lays its presence dot out from, not a class a breakpoint can change.
 */
function PhoneSized({ small, large }: { small: React.ReactNode; large: React.ReactNode }) {
    return (
        <>
            <span className="contents md:hidden">{large}</span>
            <span className="hidden md:contents">{small}</span>
        </>
    );
}

/**
 * Right-click a conversation in the list.
 *
 * The address is the point of it: every conversation is a URL, and the place
 * somebody looks for it is the row with its name on, not the room after opening
 * it. Muting is here because it is the other thing anybody does to a row without
 * wanting to read it first.
 */
function RowMenu({
    channel,
    onManage,
    children
}: {
    channel: ChatChannelView;
    onManage?: (channel: ChatChannelView, action: ChannelManage) => void;
    children: React.ReactNode;
}) {
    const baseUrl = useAppUrl();
    const router = useRouter();
    const here = usePathname();
    const { blocked, refresh, spaces } = useChat();
    const t = useTranslations("chat");
    const [naming, setNaming] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [inviting, setInviting] = useState(false);
    // The space a channel lives in, and whether this reader may bring people
    // into it: the same rule the space's own menu in the server rail uses.
    const space = channel.spaceId
        ? (spaces.find((entry) => entry.id === channel.spaceId) ?? null)
        : null;
    const mayInvite = space !== null && (space.access !== "member" || space.visibility !== "private");
    const [error, setError] = useState("");
    // A one-to-one conversation, which is the only kind where there is one
    // person to have a name for. A group is called what the group is called.
    const person = channel.kind === "dm" && channel.others.length === 1 ? channel.others[0]! : null;
    // Only a group can be left. A direct message is between two people and has
    // no door; a channel in a space is left by leaving the space.
    const group = channel.kind === "group";
    // Only the conversation on screen can be closed; any other row is already
    // closed.
    const showing = here === `/chat/c/${channel.id}` || here.startsWith(`/chat/c/${channel.id}/`);

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                    {/* Back to the empty screen, as Escape does. Nothing is left
                        or deleted: the conversation is only no longer open. */}
                    {showing && (
                        <>
                            <ContextMenuItem onSelect={() => router.push("/chat")}>
                                <X className="size-3.5" />
                                {t("sidebar.closeChat")}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                        </>
                    )}
                    {/* Kept for this reader and nobody else, which is why it sits
                    beside muting rather than in the channel's settings. */}
                    <ContextMenuItem
                        onSelect={async () => {
                            await actions.setPinnedAction(channel.id, !channel.pinned);
                            refresh();
                        }}
                    >
                        {channel.pinned ? (
                            <PinOff className="size-3.5" />
                        ) : (
                            <Pin className="size-3.5" />
                        )}
                        {channel.pinned ? t("sidebar.unpin") : t("sidebar.pinToTheTop")}
                    </ContextMenuItem>
                    {/* Only where there is something to put back. A conversation
                    already carrying a badge has nothing to mark, and an item
                    that does nothing is worse than one that is not drawn. */}
                    {channel.unread === 0 ? (
                        <ContextMenuItem
                            onSelect={async () => {
                                await actions.markUnreadAction({ channelId: channel.id });
                                refresh();
                            }}
                        >
                            <Mail className="size-3.5" />
                            {t("sidebar.markAsUnread")}
                        </ContextMenuItem>
                    ) : (
                        <ContextMenuItem
                            onSelect={async () => {
                                await actions.markChannelsReadAction({ channelIds: [channel.id] });
                                refresh();
                            }}
                        >
                            <CheckCheck className="size-3.5" />
                            {t("channelMenu.markRead")}
                        </ContextMenuItem>
                    )}
                    {/* An invitation into the space the channel is in: a
                        channel has no door of its own, and the person arriving
                        sees what any member of the space sees. */}
                    {mayInvite && (
                        <ContextMenuItem onSelect={() => setInviting(true)}>
                            <UserPlus className="size-3.5" />
                            {t("channelMenu.invite")}
                        </ContextMenuItem>
                    )}
                    <ContextMenuItem
                        onSelect={() => void copyText(channelLink(baseUrl, channel.id))}
                    >
                        <Link2 className="size-3.5" />
                        {t("sidebar.copyLink")}
                    </ContextMenuItem>
                    {/* What a bot, an integration or an API call names it by. */}
                    <ContextMenuItem onSelect={() => void copyText(channel.id)}>
                        <Fingerprint className="size-3.5" />
                        {t("channelMenu.copyId")}
                    </ContextMenuItem>
                    <MuteOptions
                        channel={channel}
                        parts={CONTEXT_PARTS}
                        onChoose={async (minutes) => {
                            await actions.setMutedAction(channel.id, minutes);
                            refresh();
                        }}
                    />
                    {/* Not in a one-to-one conversation: every message in one is
                        addressed to you, so "only mentions" would mean nothing
                        and the mute is the whole of the question. */}
                    {channel.kind !== "dm" && (
                        <NotifyOptions
                            level={channel.notifyLevel}
                            parts={CONTEXT_PARTS}
                            inheritable={channel.spaceId !== null}
                            onChoose={async (level) => {
                                await actions.setChannelNotifyAction(channel.id, level);
                                refresh();
                            }}
                        />
                    )}

                    {/* Ring them from the row. The address is the whole
                        mechanism - arriving with `answer` on it is what starts
                        the call, which is the same path answering a missed one
                        takes - so there is no second copy of "start a call"
                        here to fall out of step with the one in the room. */}
                    {channel.kind !== "text" && (
                        <ContextMenuItem
                            onSelect={() => router.push(`/chat/c/${channel.id}?answer=1`)}
                        >
                            <Phone className="size-3.5" />
                            {t("sidebar.startACall")}
                        </ContextMenuItem>
                    )}

                    {/* What you call them, offered from the row as well as from
                    the open conversation: it is a note about a person, and the
                    place somebody reaches for it is wherever their name is
                    written. Nothing is announced and nobody else sees it. */}
                    {person && (
                        <ContextMenuItem onSelect={() => setNaming(true)}>
                            <Pencil className="size-3.5" />
                            {t("sidebar.nickname")}
                        </ContextMenuItem>
                    )}

                    {/* The heavy one, and the reason it is here: somebody
                        deciding they are done with a person decides it looking
                        at the row with their name on, not after opening the
                        conversation and finding their way to their profile.
                        Below the rest and marked, so it is not next to Pin. */}
                    {person && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                variant={blocked.has(person.id) ? undefined : "danger"}
                                onSelect={async () => {
                                    const result = await runAction(
                                        () =>
                                            blocked.has(person.id)
                                                ? unblockPersonAction({ userId: person.id })
                                                : blockPersonAction({ userId: person.id }),
                                        setError
                                    );
                                    if (!result?.error) refresh();
                                }}
                            >
                                {blocked.has(person.id) ? (
                                    <ShieldOff className="size-3.5" />
                                ) : (
                                    <Ban className="size-3.5" />
                                )}
                                {blocked.has(person.id) ? t("sidebar.unblock") : t("sidebar.block")}
                            </ContextMenuItem>
                        </>
                    )}

                    {/* The same item the open conversation offers, offered from
                    the row as well. Leaving is a decision about a conversation
                    rather than something done inside it, and the place somebody
                    reaches for it is the list - which is where they are when
                    they decide they are done with it, and is the one place they
                    do not have to open it first. */}
                    {group && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem variant="danger" onSelect={() => setLeaving(true)}>
                                <LogOut className="size-3.5" />
                                {t("sidebar.leaveThisGroup")}
                            </ContextMenuItem>
                        </>
                    )}

                    {/* Only for somebody who administers the space, and only for a
                    channel in one: a direct message has no settings and a group
                    is managed from its own header. */}
                    {onManage && channel.spaceId && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => onManage(channel, "edit")}>
                                <Settings2 className="size-3.5" />
                                {t("sidebar.editChannel")}
                            </ContextMenuItem>
                            {/* The settings, people and access rules, under a
                                new name. Never the messages. */}
                            <ContextMenuItem onSelect={() => onManage(channel, "duplicate")}>
                                <Copy className="size-3.5" />
                                {t("channelMenu.duplicate")}
                            </ContextMenuItem>
                            {/* Under the same heading as this one, which is
                                what reaching for it from this row means. */}
                            <ContextMenuItem onSelect={() => onManage(channel, "create")}>
                                <Plus className="size-3.5" />
                                {t("channelMenu.create")}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                variant="danger"
                                onSelect={() => onManage(channel, "delete")}
                            >
                                <Trash2 className="size-3.5" />
                                {t("channelMenu.delete")}
                            </ContextMenuItem>
                        </>
                    )}
                </ContextMenuContent>
            </ContextMenu>
            {/* Outside the menu, which closes on the item that opens this: a dialog
            mounted inside one is unmounted the moment it is asked for. */}
            <NicknameDialog
                open={naming}
                onOpenChange={setNaming}
                person={person}
                onSaved={refresh}
            />
            {/* Mounted only while asked for: one per row, closed, would be a
                dialog per channel down the whole rail. */}
            {inviting && mayInvite && (
                <InviteDialog
                    space={space}
                    onOpenChange={(next: boolean) => !next && setInviting(false)}
                />
            )}
            {group && (
                <LeaveDialog
                    open={leaving}
                    onOpenChange={setLeaving}
                    kind="group"
                    name={channel.name}
                    error={leaving ? error : ""}
                    onLeave={async (quietly) => {
                        setError("");
                        const result = await runAction(
                            () => actions.leaveChannelAction(channel.id, quietly),
                            setError
                        );
                        // Left open on a refusal, with the reason on it: a dialog
                        // that closes and leaves you in the group is a dialog that
                        // looks like it worked.
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        setLeaving(false);
                        refresh();
                        // Only when it is the room on screen. Leaving one from
                        // the list while reading another must not throw the
                        // reader out of what they were reading.
                        if (here.startsWith(`/chat/c/${channel.id}`)) router.push("/chat");
                    }}
                />
            )}
        </>
    );
}

/**
 * Right-click a heading.
 *
 * Reading and folding are anybody's, since they only change this reader's view.
 * Making, renaming and deleting are the space administrator's. Deleting a
 * heading keeps its channels: they move up to the ones under no heading.
 */
function CategoryMenuItems({
    folded,
    unread,
    onMarkRead,
    onToggle,
    onFoldAll,
    manage
}: {
    folded: boolean;
    /** Whether anything under it is unread, so "mark as read" has a point. */
    unread: boolean;
    onMarkRead: () => void;
    onToggle: () => void;
    onFoldAll: (fold: boolean) => void;
    manage: { onCreate: () => void; onRename: () => void; onDelete: () => void } | null;
}) {
    const t = useTranslations("chat");
    return (
        <>
            {unread && (
                <ContextMenuItem onSelect={onMarkRead}>
                    <CheckCheck className="size-3.5" />
                    {t("channelMenu.markRead")}
                </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={onToggle}>
                <ChevronDown className={cn("size-3.5", folded && "-rotate-90")} />
                {folded ? t("channelMenu.expand") : t("channelMenu.collapse")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onFoldAll(true)}>
                <ChevronsDownUp className="size-3.5" />
                {t("channelMenu.collapseAll")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onFoldAll(false)}>
                <ChevronsUpDown className="size-3.5" />
                {t("channelMenu.expandAll")}
            </ContextMenuItem>
            {manage && (
                <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={manage.onCreate}>
                        <Plus className="size-3.5" />
                        {t("channelMenu.create")}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={manage.onRename}>
                        <Pencil className="size-3.5" />
                        {t("channelMenu.editCategory")}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="danger" onSelect={manage.onDelete}>
                        <Trash2 className="size-3.5" />
                        {t("channelMenu.deleteCategory")}
                    </ContextMenuItem>
                </>
            )}
        </>
    );
}

function SidebarSkeleton() {
    return (
        <div className="flex flex-col gap-4 px-1 pt-1" aria-hidden="true">
            {[0, 1].map((group) => (
                <div key={group} className="flex flex-col gap-1.5">
                    <Skeleton className="h-3 w-24" />
                    {[0, 1, 2].map((row) => (
                        <Skeleton key={row} className="h-6 w-full" />
                    ))}
                </div>
            ))}
        </div>
    );
}
