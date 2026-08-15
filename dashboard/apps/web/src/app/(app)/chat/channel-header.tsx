"use client";

/**
 * What conversation you are in, and what can be done to it.
 *
 * The topic sits beside the name rather than under it, because it is a subtitle
 * for the channel and not a second heading - and on a narrow screen it is the
 * first thing to go, since the name is what identifies the room.
 *
 * The back arrow only exists below the breakpoint where the conversation list
 * steps aside. Above it the list is right there, and an arrow that goes to a
 * place already on screen is furniture.
 */

import Link from "next/link";
import { useState } from "react";
import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { AddPeopleDialog } from "./add-people-dialog";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { ArrowLeft, Bell, BellOff, Hash, Lock, MoreHorizontal, Trash2, UserPlus, Users } from "lucide-react";
import {
    ConfirmDeleteDialog,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

export function ChannelHeader({
    channel,
    onChanged
}: {
    channel: ChatChannelView;
    onChanged: () => void;
}) {
    const router = useRouter();
    const [adding, setAdding] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [error, setError] = useState("");

    const named = channel.spaceId !== null;
    const Icon = channel.private ? Lock : named ? Hash : Users;

    const act = async (run: () => Promise<{ error?: string }>) => {
        const result = await runAction(run, setError);
        if (!result?.error) onChanged();
    };

    return (
        <>
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    href="/chat"
                    aria-label="Back to conversations"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>

                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-semibold" title={channel.name}>
                    {channel.name}
                </span>
                {channel.topic && (
                    <>
                        <span className="hidden h-4 w-px bg-border sm:block" />
                        <span
                            className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block"
                            title={channel.topic}
                        >
                            {channel.topic}
                        </span>
                    </>
                )}

                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {named && (
                        <button
                            type="button"
                            aria-label="Add people"
                            title="Add people"
                            onClick={() => setAdding(true)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <UserPlus className="size-4" />
                        </button>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="More for this conversation"
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <MoreHorizontal className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onSelect={() =>
                                    void act(() => actions.setMutedAction(channel.id, !channel.muted))
                                }
                            >
                                {channel.muted ? (
                                    <Bell className="size-3.5" />
                                ) : (
                                    <BellOff className="size-3.5" />
                                )}
                                {channel.muted ? "Unmute" : "Mute"}
                            </DropdownMenuItem>
                            {named && (
                                <>
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            void act(() =>
                                                actions.updateChannelAction({
                                                    channelId: channel.id,
                                                    archived: !channel.archived
                                                })
                                            )
                                        }
                                    >
                                        {channel.archived ? "Reopen channel" : "Archive channel"}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onSelect={() => setConfirmDelete(true)}>
                                        <Trash2 className="size-3.5" />
                                        Delete channel
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            {error && (
                <p role="alert" className="border-b border-border px-4 py-1 text-xs text-destructive">
                    {error}
                </p>
            )}

            <AddPeopleDialog open={adding} onOpenChange={setAdding} channel={channel} onAdded={onChanged} />

            <ConfirmDeleteDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                name={channel.name}
                kind="channel"
                description="Every message in it goes with it. Archiving keeps them readable instead."
                confirmLabel="Delete channel"
                onConfirm={async () => {
                    await runAction(() => actions.deleteChannelAction(channel.id), setError);
                    setConfirmDelete(false);
                    onChanged();
                    router.push("/chat");
                }}
            />
        </>
    );
}
