"use client";

/**
 * What a right-click on somebody in the roster offers.
 *
 * The column used to do one thing: pressing a name opened a direct message. That
 * is the right thing for a press, and it left everything else - mentioning them,
 * calling them, inviting them somewhere, and every moderation decision there is -
 * with no home at all. So the roster is where they live now, which is where
 * every client with rooms in it puts them.
 *
 * The menu is written as one component rather than assembled per surface,
 * because the questions it answers are the same wherever somebody's name is:
 * who is this, how do I reach them, and - if the room is mine to run - what can
 * I do about them. What differs is only which of the answers apply, and that is
 * decided here from the conversation rather than by whoever draws it.
 *
 * Two rules run through all of it and neither is arbitrary:
 *
 * **A group cannot ban.** A group is people who got there by invitation from
 * somebody already in it. There is no door to stand at, so taking somebody out
 * is all there is to do, and a ban would be a lock on a room with no walls.
 *
 * **Nothing that would be refused is offered.** An item that opens a menu and
 * then says no is worse than one that is not there - except where its absence
 * would be confusing, which is exactly the case for inviting somebody to a
 * server when you administer none. That one is shown and disabled, because "why
 * can I not invite people" is a question worth answering in place.
 */

import * as actions from "./actions";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useState, type ReactNode } from "react";
import { setVolumeFor, volumeFor } from "./call-volumes";
import { memberActions } from "./member-actions";
import type { ChatChannelView, ChatMemberView } from "@/lib/chat/chat-service";
import {
    AtSign,
    Ban,
    Crown,
    MessageSquare,
    Phone,
    PenLine,
    Timer,
    UserMinus,
    UserPlus,
    Volume2,
    VolumeX
} from "lucide-react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger
} from "@polaris/ui";

/**
 * How long a timeout lasts, as the menu offers it.
 *
 * The ladder every client uses, and for the reason they all landed on the same
 * one: the useful answers are "cool off", "the rest of this argument" and "come
 * back tomorrow", and a box accepting minutes is a box somebody types 10000 into
 * at four in the morning.
 */
const TIMEOUTS: readonly { minutes: number; label: string }[] = [
    { minutes: 5, label: "5 minutes" },
    { minutes: 60, label: "an hour" },
    { minutes: 60 * 24, label: "a day" },
    { minutes: 60 * 24 * 7, label: "a week" }
];

/** How somebody is written into a message. The same address the rest of Polaris
 *  uses for a person, so it resolves to their current name wherever it is read
 *  rather than freezing whatever they were called today. */
function mentionOf(member: ChatMemberView): string {
    return `[${member.name.replace(/[[\]]/g, "").trim() || "Somebody"}](polaris:user/${member.userId})`;
}

export function MemberMenu({
    member,
    channel,
    viewerId,
    onMention,
    onNickname,
    onChanged,
    onError,
    children
}: {
    member: ChatMemberView;
    /** The conversation their name was pressed in, which decides nearly
     *  everything below: whether there is a space to invite to or be banned
     *  from, whether this is a group with an owner, and who may moderate. */
    channel: ChatChannelView;
    viewerId: string;
    /** Put them in what is being written. The composer owns the box; this only
     *  says what to drop in it. */
    onMention: (text: string) => void;
    onNickname: (member: ChatMemberView) => void;
    onChanged: () => void;
    onError: (message: string) => void;
    children: ReactNode;
}) {
    const router = useRouter();
    const { spaces } = useChat();
    const [busy, setBusy] = useState(false);
    // Read once, when the menu is built. A volume is not something that changes
    // under somebody while they are looking at the menu that sets it.
    const [silenced, setSilenced] = useState(() => volumeFor(member.userId) === 0);

    /** What this reader may do about them here - see `memberActions`, which is
     *  where the rules live and where they are asserted. */
    const may = memberActions({
        memberId: member.userId,
        viewerId,
        room: channel,
        spaces
    });
    const you = !may.any;
    const space = channel.spaceId;
    const invitable = may.invitable;

    const run = async (what: () => Promise<{ error?: string } | null>) => {
        setBusy(true);
        const result = await runAction(what, onError);
        setBusy(false);
        if (!result?.error) onChanged();
    };

    /** Open the conversation with them, and go there. */
    const openDirect = async (then: (channelId: string) => void) => {
        setBusy(true);
        const result = await runAction(
            () => actions.openDirectAction({ userIds: [member.userId] }),
            onError
        );
        setBusy(false);
        if (result?.id) then(result.id);
    };

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
                <ContextMenuLabel className="truncate">{member.name}</ContextMenuLabel>
                <ContextMenuSeparator />

                {!you && (
                    <>
                        <ContextMenuItem
                            disabled={busy}
                            onSelect={() =>
                                void openDirect((id) => router.push(`/chat/c/${id}`))
                            }
                        >
                            <MessageSquare className="size-3.5" />
                            Message
                        </ContextMenuItem>
                        {/* The same conversation, arriving with the call already
                            starting. The address is what carries that, the way
                            answering a call from outside a conversation does. */}
                        <ContextMenuItem
                            disabled={busy}
                            onSelect={() =>
                                void openDirect((id) => router.push(`/chat/c/${id}?answer=1`))
                            }
                        >
                            <Phone className="size-3.5" />
                            Call
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => onMention(mentionOf(member))}>
                            <AtSign className="size-3.5" />
                            Mention
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => onNickname(member)}>
                            <PenLine className="size-3.5" />
                            Change nickname
                        </ContextMenuItem>
                        {/* Yours alone. Nobody is told, because it is a decision
                            about a pair of ears - see `call-volumes`. */}
                        <ContextMenuItem
                            onSelect={() => {
                                setVolumeFor(member.userId, silenced ? 1 : 0);
                                setSilenced(!silenced);
                            }}
                        >
                            {silenced ? (
                                <Volume2 className="size-3.5" />
                            ) : (
                                <VolumeX className="size-3.5" />
                            )}
                            {silenced ? "Let them through" : "Silence them for you"}
                        </ContextMenuItem>

                        {/* Shown even when it can do nothing, and that is
                            deliberate: somebody who administers no server needs
                            to be told that is why, not left looking for a menu
                            item that is not there. */}
                        {invitable.length === 0 ? (
                            <ContextMenuItem disabled>
                                <UserPlus className="size-3.5" />
                                No server to invite them to
                            </ContextMenuItem>
                        ) : (
                            <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                    <UserPlus className="size-3.5" />
                                    Invite to a server
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent className="max-h-72 overflow-y-auto">
                                    {invitable.map((entry) => (
                                        <ContextMenuItem
                                            key={entry.id}
                                            disabled={busy}
                                            onSelect={() =>
                                                void run(() =>
                                                    actions.addSpaceMembersAction({
                                                        spaceId: entry.id,
                                                        userIds: [member.userId]
                                                    })
                                                )
                                            }
                                        >
                                            <span className="truncate" title={entry.name}>{entry.name}</span>
                                        </ContextMenuItem>
                                    ))}
                                </ContextMenuSubContent>
                            </ContextMenuSub>
                        )}
                    </>
                )}

                {may.transfer && (
                    <>
                        <ContextMenuSeparator />
                        {/* A group that cannot be handed over is a group that
                            dies with an account. */}
                        <ContextMenuItem
                            disabled={busy}
                            onSelect={() =>
                                void run(() =>
                                    actions.transferGroupAction(channel.id, member.userId)
                                )
                            }
                        >
                            <Crown className="size-3.5" />
                            Make them the owner
                        </ContextMenuItem>
                    </>
                )}

                {may.moderate && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuSub>
                            <ContextMenuSubTrigger>
                                <Timer className="size-3.5" />
                                Time out
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                                {TIMEOUTS.map((choice) => (
                                    <ContextMenuItem
                                        key={choice.minutes}
                                        disabled={busy}
                                        onSelect={() =>
                                            void run(() =>
                                                actions.timeOutMemberAction(
                                                    space
                                                        ? { spaceId: space }
                                                        : { channelId: channel.id },
                                                    member.userId,
                                                    choice.minutes
                                                )
                                            )
                                        }
                                    >
                                        For {choice.label}
                                    </ContextMenuItem>
                                ))}
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                    disabled={busy}
                                    onSelect={() =>
                                        void run(() =>
                                            actions.timeOutMemberAction(
                                                space ? { spaceId: space } : { channelId: channel.id },
                                                member.userId,
                                                0
                                            )
                                        )
                                    }
                                >
                                    Let them speak again
                                </ContextMenuItem>
                            </ContextMenuSubContent>
                        </ContextMenuSub>

                        <ContextMenuItem
                            disabled={busy}
                            onSelect={() =>
                                void run(() =>
                                    space
                                        ? actions.removeSpaceMemberAction(space, member.userId)
                                        : actions.removeChannelMemberAction(
                                              channel.id,
                                              member.userId
                                          )
                                )
                            }
                        >
                            <UserMinus className="size-3.5" />
                            {space ? "Remove from the server" : "Remove from the group"}
                        </ContextMenuItem>

                        {/* Only a space. See `memberActions`. */}
                        {may.ban && space && (
                            <ContextMenuItem
                                disabled={busy}
                                onSelect={() =>
                                    void run(() =>
                                        actions.banFromSpaceAction(space, member.userId)
                                    )
                                }
                            >
                                <Ban className="size-3.5 text-danger" />
                                <span className="text-danger">Ban from the server</span>
                            </ContextMenuItem>
                        )}
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}
