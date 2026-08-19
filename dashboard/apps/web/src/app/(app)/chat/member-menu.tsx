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
 * Three rules run through all of it and none is arbitrary:
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
 *
 * **Blocking is not moderation, and it sits apart from it.** Timing somebody out
 * is a room deciding something and needs standing in that room; blocking is one
 * person deciding about their own attention and needs none. So it is the last
 * item of what you do about a person rather than the first of what a moderator
 * does, and it is the one thing here that everybody can reach.
 */

import * as actions from "./actions";
import { useChat } from "./chat-context";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useState, type ReactNode } from "react";
import { setVolumeFor, volumeFor } from "./call-volumes";
import { memberActions } from "./member-actions";
import { useOpenDirect } from "./use-open-direct";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { blockPersonAction, unblockPersonAction } from "@/app/(app)/account/privacy/actions";
import {
    AtSign,
    Ban,
    Crown,
    MessageSquare,
    Phone,
    PenLine,
    ShieldBan,
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
    ContextMenuTrigger,
    keepFocusOnClose
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

/**
 * Somebody the menu is about.
 *
 * Deliberately not the roster's own row: the same menu opens on a name in the
 * middle of a conversation, where all that is known about the writer is who they
 * are and what they are called. Nothing in here needs more than that, and asking
 * for a role that is not to hand would mean inventing one.
 */
export interface MenuPerson {
    readonly userId: string;
    readonly name: string;
}

/** How somebody is written into a message. The same address the rest of Polaris
 *  uses for a person, so it resolves to their current name wherever it is read
 *  rather than freezing whatever they were called today. */
function mentionOf(member: MenuPerson): string {
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
    member: MenuPerson;
    /** The conversation their name was pressed in, which decides nearly
     *  everything below: whether there is a space to invite to or be banned
     *  from, whether this is a group with an owner, and who may moderate. */
    channel: ChatChannelView;
    viewerId: string;
    /** Put them in what is being written. The composer owns the box; this only
     *  says what to drop in it. Absent where there is no box under the list, and
     *  then the item is not drawn rather than drawn doing nothing. */
    onMention?: (text: string) => void;
    onNickname: (member: MenuPerson) => void;
    onChanged: () => void;
    onError: (message: string) => void;
    children: ReactNode;
}) {
    const router = useRouter();
    const { spaces, blocked, refresh } = useChat();
    const [busy, setBusy] = useState(false);
    const direct = useOpenDirect(onError);
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
    const shut = blocked.has(member.userId);

    const run = async (what: () => Promise<{ error?: string } | null>) => {
        setBusy(true);
        const result = await runAction(what, onError);
        setBusy(false);
        if (!result?.error) onChanged();
    };

    /**
     * Block them, or let them through again.
     *
     * Its own handler rather than `run`, because the rail has to be asked again:
     * a block changes what the conversation list carries - whether the composer
     * offers a box or an explanation - and the roster reload `onChanged` does
     * would leave that a screen behind.
     */
    const toggleBlock = async () => {
        setBusy(true);
        const result = await runAction(
            () =>
                shut
                    ? unblockPersonAction({ userId: member.userId })
                    : blockPersonAction({ userId: member.userId }),
            onError
        );
        setBusy(false);
        if (result?.error) return;
        refresh();
        onChanged();
    };

    const working = busy || direct.busy;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            {/* Focus is not handed back to whatever was right-clicked. Mention
                puts the caret in the composer, and the hand-back landed a beat
                later and took it straight out again - which read as a mention
                that dropped the name in and then refused to let anybody finish
                the sentence. */}
            <ContextMenuContent className="w-56" onCloseAutoFocus={keepFocusOnClose}>
                <ContextMenuLabel className="truncate">{member.name}</ContextMenuLabel>
                <ContextMenuSeparator />

                {!you && (
                    <>
                        {/* The three ways of reaching somebody, and all three
                            go when this reader has blocked them - the server
                            refuses each one, and it refuses them with a sentence
                            that cannot say why. It cannot: naming the block
                            would also name it in the case where the OTHER person
                            set it, which is the one thing that must never be
                            said. So the honesty lives here instead, where the
                            block is this reader's own and Unblock is one item
                            further down. */}
                        {!shut && (
                            <>
                                <ContextMenuItem
                                    disabled={working}
                                    onSelect={() => void direct.open(member.userId)}
                                >
                                    <MessageSquare className="size-3.5" />
                                    Message
                                </ContextMenuItem>
                                {/* The same conversation, arriving with the call
                                    already starting. The address is what carries
                                    that, the way answering a call from outside a
                                    conversation does. */}
                                <ContextMenuItem
                                    disabled={working}
                                    onSelect={() =>
                                        void direct.open(member.userId, (id) =>
                                            router.push(`/chat/c/${id}?answer=1`)
                                        )
                                    }
                                >
                                    <Phone className="size-3.5" />
                                    Call
                                </ContextMenuItem>
                                {onMention && (
                                    <ContextMenuItem
                                        onSelect={() => onMention(mentionOf(member))}
                                    >
                                        <AtSign className="size-3.5" />
                                        Mention
                                    </ContextMenuItem>
                                )}
                            </>
                        )}
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
                                            disabled={working}
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

                        <ContextMenuSeparator />
                        {/* Last in the group of things you do about a person,
                            because it is the heaviest of them and because it is
                            the one that should not be next to Message. Not in
                            the moderation group below it either: that is a room
                            deciding something, and this is not. */}
                        <ContextMenuItem
                            disabled={working}
                            onSelect={() => void toggleBlock()}
                        >
                            <ShieldBan className={shut ? "size-3.5" : "size-3.5 text-danger"} />
                            <span className={shut ? undefined : "text-danger"}>
                                {shut ? "Unblock" : "Block"}
                            </span>
                        </ContextMenuItem>
                    </>
                )}

                {may.transfer && (
                    <>
                        <ContextMenuSeparator />
                        {/* A group that cannot be handed over is a group that
                            dies with an account. */}
                        <ContextMenuItem
                            disabled={working}
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
                                        disabled={working}
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
                                    disabled={working}
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
                            disabled={working}
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
                                disabled={working}
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
