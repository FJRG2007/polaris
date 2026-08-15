"use client";

/**
 * The conversation list.
 *
 * Ordered the way people look for a conversation rather than the way the data
 * is shaped: direct messages first, because those are the ones with somebody's
 * name on them, then each space with its channels under it. Inside a space the
 * channels keep the order they were made in, so the list does not rearrange
 * itself while somebody is reading it - a rail that reorders on every message is
 * a rail you cannot learn.
 *
 * A conversation with something unread is bold and carries a count. That is the
 * whole treatment: no colour, no dot as well as a number, and nothing that moves.
 */

import Link from "next/link";
import * as actions from "./actions";
import { useChat } from "./chat-context";
import { useParams } from "next/navigation";
import { Avatar } from "@/components/avatar";
import { NewSpaceDialog } from "./new-space-dialog";
import { useEffect, useMemo, useState } from "react";
import { NewDirectDialog } from "./new-direct-dialog";
import { NewChannelDialog } from "./new-channel-dialog";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import { ChevronDown, Hash, Lock, MessageSquarePlus, Plus, Users } from "lucide-react";
import {
    cn,
    Skeleton,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";

export function ChatSidebar() {
    const { channels, loaded } = useChat();
    const params = useParams<{ channelId?: string }>();
    const open = params.channelId ?? null;

    const [spaces, setSpaces] = useState<readonly ChatSpaceView[]>([]);
    const [folded, setFolded] = useState<readonly string[]>([]);
    const [newSpace, setNewSpace] = useState(false);
    const [newDirect, setNewDirect] = useState(false);
    const [newChannelIn, setNewChannelIn] = useState<ChatSpaceView | null>(null);
    const [error, setError] = useState("");

    const loadSpaces = () => {
        void actions.listSpacesAction().then((result) => setSpaces(result.spaces));
    };
    useEffect(loadSpaces, []);

    const directs = useMemo(
        () =>
            channels
                .filter((channel) => channel.spaceId === null)
                .sort((left, right) =>
                    (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
                ),
        [channels]
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-header shrink-0 items-center justify-between gap-2 border-b border-border px-3">
                <span className="text-sm font-semibold">Chat</span>
                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        aria-label="Start a direct message"
                        title="Start a direct message"
                        onClick={() => setNewDirect(true)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <MessageSquarePlus className="size-4" />
                    </button>
                    <button
                        type="button"
                        aria-label="New space"
                        title="New space"
                        onClick={() => setNewSpace(true)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <Plus className="size-4" />
                    </button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {error && (
                    <p role="alert" className="px-1 pb-2 text-xs text-destructive">
                        {error}
                    </p>
                )}

                {!loaded ? (
                    <SidebarSkeleton />
                ) : (
                    <>
                        <Section
                            label="Direct messages"
                            folded={folded.includes("dm")}
                            onToggle={() => toggle("dm")}
                        >
                            {directs.length === 0 ? (
                                <p className="px-2 py-1 text-xs text-foreground-subtle">
                                    Nobody yet.
                                </p>
                            ) : (
                                directs.map((channel) => (
                                    <Row
                                        key={channel.id}
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

                        {spaces.map((space) => {
                            const inSpace = channels.filter(
                                (channel) => channel.spaceId === space.id && !channel.archived
                            );
                            return (
                                <Section
                                    key={space.id}
                                    label={space.name}
                                    folded={folded.includes(space.id)}
                                    onToggle={() => toggle(space.id)}
                                    action={
                                        space.access === "member" ? null : (
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <button
                                                        type="button"
                                                        aria-label={`More for ${space.name}`}
                                                        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                                                    >
                                                        <Plus className="size-3.5" />
                                                    </button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem
                                                        onSelect={() => setNewChannelIn(space)}
                                                    >
                                                        <Hash className="size-3.5" />
                                                        New channel
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        )
                                    }
                                >
                                    {inSpace.length === 0 ? (
                                        <p className="px-2 py-1 text-xs text-foreground-subtle">
                                            No channels yet.
                                        </p>
                                    ) : (
                                        inSpace.map((channel) => (
                                            <Row
                                                key={channel.id}
                                                href={`/chat/c/${channel.id}`}
                                                active={open === channel.id}
                                                unread={channel.unread}
                                                muted={channel.muted}
                                                label={channel.name}
                                                icon={
                                                    channel.private ? (
                                                        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                                                    ) : (
                                                        <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                                                    )
                                                }
                                            />
                                        ))
                                    )}
                                </Section>
                            );
                        })}

                        {spaces.length === 0 && (
                            <p className="px-2 py-3 text-xs text-muted-foreground">
                                No spaces yet. A space holds channels, the way a room holds
                                conversations.
                            </p>
                        )}
                    </>
                )}
            </div>

            <NewSpaceDialog
                open={newSpace}
                onOpenChange={setNewSpace}
                onCreated={() => {
                    loadSpaces();
                    setError("");
                }}
            />
            <NewDirectDialog open={newDirect} onOpenChange={setNewDirect} />
            <NewChannelDialog
                space={newChannelIn}
                onOpenChange={(next) => !next && setNewChannelIn(null)}
            />
        </div>
    );

    function toggle(id: string): void {
        setFolded((current) =>
            current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
        );
    }
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
    icon
}: {
    href: string;
    active: boolean;
    unread: number;
    muted: boolean;
    label: string;
    icon: React.ReactNode;
}) {
    // A muted conversation still counts its messages - it just does not shout
    // about them, which is the difference between muting and leaving.
    const shout = unread > 0 && !muted;
    return (
        <Link
            href={href}
            className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-card-hover",
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
                        muted ? "bg-muted text-muted-foreground" : "bg-primary text-white"
                    )}
                >
                    {unread > 98 ? "99+" : unread}
                </span>
            )}
        </Link>
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
