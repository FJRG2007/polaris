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
import { rememberChannel } from "./recents";
import { Avatar } from "@/components/avatar";
import { channelLink, copyText } from "./links";
import { useAppUrl } from "@/components/app-url";
import { ChatAvatar } from "@/components/chat-avatar";
import { NewDirectDialog } from "./new-direct-dialog";
import { NewChannelDialog } from "./new-channel-dialog";
import { useParams, usePathname, useRouter } from "next/navigation";
import type { VoicePresence } from "@/lib/chat/meetings";
import { NotifyOptions } from "./notify-menu";
import { MuteOptions, type MenuParts } from "./mute-menu";
import { LeaveDialog } from "./leave-dialog";
import { runAction } from "@/lib/run-action";
import { NicknameDialog } from "./nickname-dialog";
import { ChannelSettingsDialog } from "./channel-settings-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatChannelView, ChatSpaceView } from "@/lib/chat/chat-service";
import { reordered, useRailDrag, type Dragging, type DropTarget } from "./use-rail-drag";
import {
    ChevronDown,
    FolderPlus,
    Hash,
    Link2,
    Lock,
    LogOut,
    Mail,
    MessageSquarePlus,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Settings2,
    Star,
    Trash2,
    Video,
    Volume2
} from "lucide-react";
import {
    Button,
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
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

    useEffect(() => {
        readPresence();
        if (voiceIds.length === 0) return;
        const timer = setInterval(readPresence, PRESENCE_EVERY_MS);
        return () => clearInterval(timer);
    }, [readPresence, voiceIds.length]);

    const manages = space !== null && space.access !== "member";

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
                    {space?.name ?? "Direct messages"}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                    {space === null ? (
                        <button
                            type="button"
                            aria-label="Start a direct message"
                            title="Start a direct message"
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
                                        aria-label={`Add to ${space.name}`}
                                        title="Add a channel or a category"
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
                                        New channel
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onSelect={() => setNewCategory(true)}>
                                        <FolderPlus className="size-3.5" />
                                        New category
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )
                    )}
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
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
                    <span>Saved messages</span>
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
                    <span>Meetings</span>
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
                        label="Direct messages"
                        folded={folded.includes("dm")}
                        onToggle={() => toggle("dm")}
                    >
                        {directs.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-foreground-subtle">Nobody yet.</p>
                        ) : (
                            directs.map((channel) => (
                                <Row
                                    key={channel.id}
                                    channel={channel}
                                    href={`/chat/c/${channel.id}`}
                                    active={open === channel.id}
                                    unread={channel.unread}
                                    muted={channel.muted}
                                    label={channel.name}
                                    icon={
                                        channel.others.length === 1 && channel.others[0] ? (
                                            // Twenty rather than eighteen, which
                                            // is the size below which a face goes
                                            // without its presence dot - so this
                                            // list was the one place in Polaris
                                            // where somebody's face did not say
                                            // whether they were there.
                                            <Avatar person={channel.others[0]} size={20} />
                                        ) : (
                                            // A group is its picture, or the
                                            // faces of the people in it. An
                                            // icon shared by every group is
                                            // the one thing that cannot tell
                                            // two of them apart.
                                            <ChatAvatar
                                                kind="channel"
                                                id={channel.id}
                                                name={channel.name}
                                                members={channel.others}
                                                size={18}
                                            />
                                        )
                                    }
                                />
                            ))
                        )}
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
                                drag={drag}
                                manages={manages}
                                onManage={setManaging}
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
                                    action={
                                        manages ? (
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <button
                                                        type="button"
                                                        aria-label={`More for ${category.name}`}
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
                                                        New channel here
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
                                                        Delete category
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
                                        drag={drag}
                                        manages={manages}
                                        onManage={setManaging}
                                        empty="Nothing here yet."
                                    />
                                </Section>
                            ))}

                        {inSpace.length === 0 && (
                            <p className="px-2 py-3 text-xs text-muted-foreground">
                                No channels yet.
                            </p>
                        )}
                    </>
                )}
            </div>

            <ChannelSettingsDialog
                channel={managing}
                onOpenChange={(next) => !next && setManaging(null)}
            />

            <NewDirectDialog open={newDirect} onOpenChange={setNewDirect} />
            <NewChannelDialog
                space={newChannelIn?.space ?? null}
                categoryId={newChannelIn?.categoryId ?? null}
                onOpenChange={(next) => !next && setNewChannelIn(null)}
            />

            <Dialog open={newCategory} onOpenChange={setNewCategory}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>New category</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={categoryName}
                        autoFocus
                        placeholder="What the channels under it have in common"
                        aria-label="What the category is called"
                        onChange={(event) => setCategoryName(event.target.value)}
                    />
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setNewCategory(false)}>
                            Cancel
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
                            Create
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );

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
    empty
}: {
    channels: readonly ChatChannelView[];
    open: string | null;
    inRoom: Record<string, VoicePresence[]>;
    /** Absent in the direct-message list, which has no order to arrange. */
    drag?: ReturnType<typeof useRailDrag>;
    manages?: boolean;
    onManage?: (channel: ChatChannelView) => void;
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
                                    <li
                                        key={person.id}
                                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                                        title={person.name}
                                    >
                                        <Avatar
                                            size={16}
                                            person={{
                                                // A guest has no account behind
                                                // them; their seat is who they
                                                // are, and the initials of the
                                                // name they gave is all there is.
                                                id: person.userId ?? person.id,
                                                name: person.name
                                            }}
                                        />
                                        <span className="truncate" title={person.name}>
                                            {person.name}
                                        </span>
                                    </li>
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
    children: React.ReactNode;
}) {
    return (
        <div
            {...area}
            className={cn(
                "mb-3 rounded-md ring-1 ring-inset transition-colors duration-fast",
                into ? "bg-primary/5 ring-primary/40" : "ring-transparent"
            )}
        >
            <div {...handle} className="group relative flex items-center gap-1 px-1">
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
            {!folded && <div className="mt-0.5 flex flex-col gap-px">{children}</div>}
        </div>
    );
}

function Row({
    href,
    active,
    unread,
    muted,
    label,
    icon,
    channel,
    onManage
}: {
    href: string;
    active: boolean;
    unread: number;
    muted: boolean;
    label: string;
    icon: React.ReactNode;
    /** What a right-click acts on. Absent on the rows that are not a
     *  conversation, such as the link to what somebody has saved. */
    channel?: ChatChannelView;
    /** Present for somebody who administers the space, so the menu can offer
     *  what only they may do. */
    onManage?: (channel: ChatChannelView) => void;
}) {
    // A muted conversation still counts its messages - it just does not shout
    // about them, which is the difference between muting and leaving.
    const shout = unread > 0 && !muted;
    const row = (
        <Link
            href={href}
            className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-card-hover data-[state=open]:bg-card-hover",
                active ? "bg-card-hover text-foreground" : "text-muted-foreground",
                shout && "font-medium text-foreground"
            )}
        >
            {icon}
            <span className="min-w-0 flex-1 truncate" title={label}>
                {label}
            </span>
            {/* Said quietly, and only because a row that sits above a newer
                conversation with nothing to explain it reads as a bug. */}
            {channel?.pinned && (
                <Pin className="size-3 shrink-0 text-foreground-subtle" aria-label="Pinned" />
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
        </Link>
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
    onManage?: (channel: ChatChannelView) => void;
    children: React.ReactNode;
}) {
    const baseUrl = useAppUrl();
    const router = useRouter();
    const here = usePathname();
    const { refresh } = useChat();
    const [naming, setNaming] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [error, setError] = useState("");
    // A one-to-one conversation, which is the only kind where there is one
    // person to have a name for. A group is called what the group is called.
    const person = channel.kind === "dm" && channel.others.length === 1 ? channel.others[0]! : null;
    // Only a group can be left. A direct message is between two people and has
    // no door; a channel in a space is left by leaving the space.
    const group = channel.kind === "group";

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
                <ContextMenuContent className="w-48">
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
                        {channel.pinned ? "Unpin" : "Pin to the top"}
                    </ContextMenuItem>
                    {/* Only where there is something to put back. A conversation
                    already carrying a badge has nothing to mark, and an item
                    that does nothing is worse than one that is not drawn. */}
                    {channel.unread === 0 && (
                        <ContextMenuItem
                            onSelect={async () => {
                                await actions.markUnreadAction({ channelId: channel.id });
                                refresh();
                            }}
                        >
                            <Mail className="size-3.5" />
                            Mark as unread
                        </ContextMenuItem>
                    )}
                    <ContextMenuItem
                        onSelect={() => void copyText(channelLink(baseUrl, channel.id))}
                    >
                        <Link2 className="size-3.5" />
                        Copy link
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

                    {/* What you call them, offered from the row as well as from
                    the open conversation: it is a note about a person, and the
                    place somebody reaches for it is wherever their name is
                    written. Nothing is announced and nobody else sees it. */}
                    {person && (
                        <ContextMenuItem onSelect={() => setNaming(true)}>
                            <Pencil className="size-3.5" />
                            Nickname
                        </ContextMenuItem>
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
                                Leave this group
                            </ContextMenuItem>
                        </>
                    )}

                    {/* Only for somebody who administers the space, and only for a
                    channel in one: a direct message has no settings and a group
                    is managed from its own header. */}
                    {onManage && channel.spaceId && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => onManage(channel)}>
                                <Settings2 className="size-3.5" />
                                Edit channel
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
