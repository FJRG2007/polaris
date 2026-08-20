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
import { useState, type ComponentType, type ReactNode } from "react";
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
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

/**
 * The pieces the menu is built out of, so the same items can be reached two
 * ways.
 *
 * A right-click is how you get at somebody in a list of two hundred; a button is
 * how you get at the one person a screen is already about, where there is
 * nothing to right-click and no reason to guess that you could. Both are the
 * same menu - the same items, the same rules about which of them apply - and
 * writing it twice is how the two drift until the profile panel is missing the
 * item somebody uses.
 *
 * The two primitive sets are the same component library over the same Radix
 * menu, which is why this is a swap of parts rather than a second component.
 */
interface MenuParts {
    readonly Root: ComponentType<{ children: ReactNode }>;
    readonly Trigger: ComponentType<{ asChild?: boolean; children: ReactNode }>;
    readonly Content: ComponentType<{
        className?: string;
        align?: "start" | "center" | "end";
        onCloseAutoFocus?: (event: Event) => void;
        children: ReactNode;
    }>;
    readonly Item: ComponentType<{
        disabled?: boolean;
        onSelect?: (event: Event) => void;
        variant?: "default" | "danger";
        children: ReactNode;
    }>;
    readonly Label: ComponentType<{ className?: string; children: ReactNode }>;
    readonly Separator: ComponentType<Record<string, never>>;
    readonly Sub: ComponentType<{ children: ReactNode }>;
    readonly SubTrigger: ComponentType<{ children: ReactNode }>;
    readonly SubContent: ComponentType<{ className?: string; children: ReactNode }>;
}

const RIGHT_CLICK = {
    Root: ContextMenu,
    Trigger: ContextMenuTrigger,
    Content: ContextMenuContent,
    Item: ContextMenuItem,
    Label: ContextMenuLabel,
    Separator: ContextMenuSeparator,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent
} as unknown as MenuParts;

const PRESS = {
    Root: DropdownMenu,
    Trigger: DropdownMenuTrigger,
    Content: DropdownMenuContent,
    Item: DropdownMenuItem,
    Label: DropdownMenuLabel,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent
} as unknown as MenuParts;

export function MemberMenu({
    member,
    channel,
    viewerId,
    onMention,
    onNickname,
    onChanged,
    onError,
    openWith = "right-click",
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
    /** How the menu is opened. A right-click on whatever the children draw, or a
     *  press on it - which is what a screen already about one person offers,
     *  since there is no list there to right-click along. */
    openWith?: "right-click" | "press";
    children: ReactNode;
}) {
    const menu = openWith === "press" ? PRESS : RIGHT_CLICK;
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
        <menu.Root>
            <menu.Trigger asChild>{children}</menu.Trigger>
            {/* Focus is not handed back to whatever was right-clicked. Mention
                puts the caret in the composer, and the hand-back landed a beat
                later and took it straight out again - which read as a mention
                that dropped the name in and then refused to let anybody finish
                the sentence. */}
            <menu.Content
                className="w-56"
                // Only ever read by the pressed menu: a right-click menu is
                // placed where the pointer was, and has nothing to align to.
                align={openWith === "press" ? "end" : undefined}
                onCloseAutoFocus={keepFocusOnClose}
            >
                <menu.Label className="truncate">{member.name}</menu.Label>
                <menu.Separator />

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
                                <menu.Item
                                    disabled={working}
                                    onSelect={() => void direct.open(member.userId)}
                                >
                                    <MessageSquare className="size-3.5" />
                                    Message
                                </menu.Item>
                                {/* The same conversation, arriving with the call
                                    already starting. The address is what carries
                                    that, the way answering a call from outside a
                                    conversation does. */}
                                <menu.Item
                                    disabled={working}
                                    onSelect={() =>
                                        void direct.open(member.userId, (id) =>
                                            router.push(`/chat/c/${id}?answer=1`)
                                        )
                                    }
                                >
                                    <Phone className="size-3.5" />
                                    Call
                                </menu.Item>
                                {onMention && (
                                    <menu.Item
                                        onSelect={() => onMention(mentionOf(member))}
                                    >
                                        <AtSign className="size-3.5" />
                                        Mention
                                    </menu.Item>
                                )}
                            </>
                        )}
                        <menu.Item onSelect={() => onNickname(member)}>
                            <PenLine className="size-3.5" />
                            Change nickname
                        </menu.Item>
                        {/* Yours alone. Nobody is told, because it is a decision
                            about a pair of ears - see `call-volumes`. */}
                        <menu.Item
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
                        </menu.Item>

                        {/* Shown even when it can do nothing, and that is
                            deliberate: somebody who administers no server needs
                            to be told that is why, not left looking for a menu
                            item that is not there. */}
                        {invitable.length === 0 ? (
                            <menu.Item disabled>
                                <UserPlus className="size-3.5" />
                                No server to invite them to
                            </menu.Item>
                        ) : (
                            <menu.Sub>
                                <menu.SubTrigger>
                                    <UserPlus className="size-3.5" />
                                    Invite to a server
                                </menu.SubTrigger>
                                <menu.SubContent className="max-h-72 overflow-y-auto">
                                    {invitable.map((entry) => (
                                        <menu.Item
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
                                        </menu.Item>
                                    ))}
                                </menu.SubContent>
                            </menu.Sub>
                        )}

                        <menu.Separator />
                        {/* Last in the group of things you do about a person,
                            because it is the heaviest of them and because it is
                            the one that should not be next to Message. Not in
                            the moderation group below it either: that is a room
                            deciding something, and this is not. */}
                        <menu.Item
                            disabled={working}
                            onSelect={() => void toggleBlock()}
                        >
                            <ShieldBan className={shut ? "size-3.5" : "size-3.5 text-danger"} />
                            <span className={shut ? undefined : "text-danger"}>
                                {shut ? "Unblock" : "Block"}
                            </span>
                        </menu.Item>
                    </>
                )}

                {may.transfer && (
                    <>
                        <menu.Separator />
                        {/* A group that cannot be handed over is a group that
                            dies with an account. */}
                        <menu.Item
                            disabled={working}
                            onSelect={() =>
                                void run(() =>
                                    actions.transferGroupAction(channel.id, member.userId)
                                )
                            }
                        >
                            <Crown className="size-3.5" />
                            Make them the owner
                        </menu.Item>
                    </>
                )}

                {may.moderate && (
                    <>
                        <menu.Separator />
                        <menu.Sub>
                            <menu.SubTrigger>
                                <Timer className="size-3.5" />
                                Time out
                            </menu.SubTrigger>
                            <menu.SubContent>
                                {TIMEOUTS.map((choice) => (
                                    <menu.Item
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
                                    </menu.Item>
                                ))}
                                <menu.Separator />
                                <menu.Item
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
                                </menu.Item>
                            </menu.SubContent>
                        </menu.Sub>

                        <menu.Item
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
                        </menu.Item>

                        {/* Only a space. See `memberActions`. */}
                        {may.ban && space && (
                            <menu.Item
                                disabled={working}
                                onSelect={() =>
                                    void run(() =>
                                        actions.banFromSpaceAction(space, member.userId)
                                    )
                                }
                            >
                                <Ban className="size-3.5 text-danger" />
                                <span className="text-danger">Ban from the server</span>
                            </menu.Item>
                        )}
                    </>
                )}
            </menu.Content>
        </menu.Root>
    );
}
