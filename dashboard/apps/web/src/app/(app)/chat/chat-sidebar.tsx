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
import { Avatar } from "@/components/avatar";
import { channelLink, copyText } from "./links";
import { useAppUrl } from "@/components/app-url";
import { NewDirectDialog } from "./new-direct-dialog";
import { NewChannelDialog } from "./new-channel-dialog";
import { useParams, usePathname } from "next/navigation";
import { MuteOptions, type MenuParts } from "./mute-menu";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatChannelView, ChatSpaceView } from "@/lib/chat/chat-service";
import {
    ChevronDown,
    FolderPlus,
    Hash,
    Link2,
    Lock,
    MessageSquarePlus,
    Plus,
    Star,
    Trash2,
    Users,
    Volume2
} from "lucide-react";
import {
    Button,
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
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
    const { channels, spaces, categories, activeSpaceId, setActiveSpaceId, loaded } = useChat();
    const params = useParams<{ channelId?: string }>();
    const open = params.channelId ?? null;
    const saved = usePathname() === "/chat/saved";

    const [folded, setFolded] = useState<readonly string[]>([]);
    const [newDirect, setNewDirect] = useState(false);
    const [newChannelIn, setNewChannelIn] = useState<{
        space: ChatSpaceView;
        categoryId: string | null;
    } | null>(null);
    const [newCategory, setNewCategory] = useState(false);
    const [categoryName, setCategoryName] = useState("");
    const [error, setError] = useState("");
    const [inRoom, setInRoom] = useState<Record<string, { id: string; name: string }[]>>({});

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
        if (channel) setActiveSpaceId(channel.spaceId);
    }, [open, channels, setActiveSpaceId]);

    const directs = useMemo(
        () =>
            channels
                .filter((channel) => channel.spaceId === null)
                .sort((left, right) =>
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
                {space === null && (
                    <Link
                        href="/chat/saved"
                        className={cn(
                            "mb-3 flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-card-hover",
                            saved ? "bg-card-hover text-foreground" : "text-muted-foreground"
                        )}
                    >
                        <Star className="size-3.5 shrink-0" />
                        <span>Saved</span>
                    </Link>
                )}

                {error && (
                    <p role="alert" className="px-1 pb-2 text-xs text-destructive">
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
                                            <Avatar person={channel.others[0]} size={18} />
                                        ) : (
                                            <Users className="size-3.5 shrink-0 text-muted-foreground" />
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
                            invented "General". */}
                        <ChannelRows
                            channels={inSpace.filter((channel) => channel.categoryId === null)}
                            open={open}
                            inRoom={inRoom}
                        />

                        {categories
                            .filter((category) => category.spaceId === space.id)
                            .map((category) => (
                                <Section
                                    key={category.id}
                                    label={category.name}
                                    folded={folded.includes(category.id)}
                                    onToggle={() => toggle(category.id)}
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
    empty
}: {
    channels: readonly ChatChannelView[];
    open: string | null;
    inRoom: Record<string, { id: string; name: string }[]>;
    empty?: string;
}) {
    if (channels.length === 0) {
        return empty ? <p className="px-2 py-1 text-xs text-foreground-subtle">{empty}</p> : null;
    }

    return (
        <div className="mb-2 flex flex-col gap-px">
            {channels.map((channel) => {
                const inside = inRoom[channel.id] ?? [];
                return (
                    <div key={channel.id}>
                        <Row
                            channel={channel}
                            href={`/chat/c/${channel.id}`}
                            active={open === channel.id}
                            // A voice room has nothing to be unread: walking in
                            // is the only way to hear what is happening in one.
                            unread={channel.kind === "voice" ? 0 : channel.unread}
                            muted={channel.muted}
                            label={channel.name}
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
                                        className="truncate text-xs text-muted-foreground"
                                        title={person.name}
                                    >
                                        {person.name}
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

function Section({
    label,
    folded,
    onToggle,
    action,
    children
}: {
    label: string;
    folded: boolean;
    onToggle: () => void;
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="mb-3">
            <div className="group flex items-center gap-1 px-1">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={!folded}
                    className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left text-[11px] font-medium uppercase tracking-[0.04em] text-foreground-subtle transition-colors hover:text-foreground"
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
    channel
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
            {unread > 0 && (
                <span
                    className={cn(
                        "shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4",
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

    return channel ? <RowMenu channel={channel}>{row}</RowMenu> : row;
}

/**
 * Right-click a conversation in the list.
 *
 * The address is the point of it: every conversation is a URL, and the place
 * somebody looks for it is the row with its name on, not the room after opening
 * it. Muting is here because it is the other thing anybody does to a row without
 * wanting to read it first.
 */
function RowMenu({ channel, children }: { channel: ChatChannelView; children: React.ReactNode }) {
    const baseUrl = useAppUrl();
    const { refresh } = useChat();

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">
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
            </ContextMenuContent>
        </ContextMenu>
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
