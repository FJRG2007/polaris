"use client";

/**
 * Who is in here, down the right-hand side.
 *
 * A conversation with more than two people in it is unreadable without this: a
 * name appears, and the only way to find out whether that person is one of four
 * or one of forty is to open a dialog meant for adding somebody. Every chat
 * client with rooms in it has this column and it is not decoration - it is what
 * makes "@everyone" a size you can picture before you press send.
 *
 * The list is the room's roster as the server draws it, which for an open
 * channel is the whole space rather than the handful of people who happen to
 * have a membership row. Anything narrower would be a lie: everybody in the
 * space can read that channel.
 *
 * Ordered by standing and then by name - the owner, the administrators, then
 * everybody else - because that ordering answers the second question people
 * come here with, which is who to ask. Presence rides on the avatar the same way
 * it does everywhere else in Polaris, so a room also says who is around.
 *
 * Pressing somebody opens a direct message with them, because that is what
 * clicking a person's name in a room is for.
 */

import * as actions from "./actions";
import { useChat } from "./chat-context";
import { Avatar } from "@/components/avatar";
import { usePresence } from "@/components/presence-store";
import { useWideScreen, WIDE_ENOUGH } from "./use-wide-screen";
import { MemberMenu, type MenuPerson } from "./member-menu";
import { useOpenDirect } from "./use-open-direct";
import { NicknameDialog } from "./nickname-dialog";
import { Crown, Users, X } from "lucide-react";
import { useChatStream } from "./use-chat-stream";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatChannelView, ChatMemberView } from "@/lib/chat/chat-service";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Skeleton,
    cn
} from "@polaris/ui";

/** Where the choice to hide it is kept. Per browser and nothing else: it is a
 *  preference about a screen, not a fact about an account. */
const REMEMBERED = "polaris.chat.members";

/** Where a role sorts. Lower comes first; anything unrecognised sorts last
 *  rather than crashing the list. */
const RANK: Record<string, number> = { owner: 0, admin: 1, member: 2 };

/** The caption beside a name. Members get none: a list where every second line
 *  says "member" is a list nobody reads. Neither does the owner - a crown sits
 *  against their name instead, which is the mark every chat client uses for it
 *  and which reads at a glance in a column of forty. */
const ROLE_WORDS: Record<string, string> = { admin: "Admin" };

interface Roster {
    readonly members: readonly ChatMemberView[];
    readonly loading: boolean;
}

/**
 * Whether the panel is showing, and the switch that changes it.
 *
 * Open by default on a screen with room for it - that is what a roster is for,
 * and a column you have to ask for every time you open a room is a column
 * nobody uses. Closing it is remembered, so somebody who wants the width keeps
 * it in every conversation and after a reload.
 *
 * Never open by itself on a narrow screen: there the same state opens a dialog
 * over the conversation, and a dialog nobody asked for is not a default.
 */
export function useMembersPanel(): {
    open: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
} {
    const wide = useWideScreen();
    const [open, setShowing] = useState(false);

    useEffect(() => {
        if (!wide) return;
        setShowing(window.localStorage.getItem(REMEMBERED) !== "hidden");
    }, [wide]);

    const setOpen = useCallback((next: boolean) => {
        setShowing(next);
        // Only the deliberate close is written down. A dialog opened on a phone
        // says nothing about whether somebody wants the column on their laptop.
        if (window.matchMedia(WIDE_ENOUGH).matches) {
            window.localStorage.setItem(REMEMBERED, next ? "shown" : "hidden");
        }
    }, []);

    return { open, setOpen, toggle: useCallback(() => setOpen(!open), [open, setOpen]) };
}

/**
 * The people in one conversation, kept in step with who joins and leaves.
 *
 * @param showing - Whether anybody is looking. Nothing is fetched for a panel
 *   that is closed: the roster would otherwise be read on every conversation
 *   somebody clicks through, to draw a column that is not there.
 */
function useRoster(channelId: string, ownerId: string | null, showing: boolean): Roster {
    const [members, setMembers] = useState<readonly ChatMemberView[] | null>(null);

    const load = useCallback(async () => {
        if (!showing) return;
        const result = await actions.listMembersAction(channelId);
        setMembers(result.members ?? []);
    }, [channelId, showing]);

    useEffect(() => {
        setMembers(null);
        void load();
    }, [load]);

    // Somebody joining or leaving is exactly the frame this list exists to
    // follow, and it is the one the rail already listens for.
    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind === "channels") void load();
            },
            [load]
        )
    );

    const sorted = useMemo(() => {
        const rows = (members ?? []).map((member) =>
            // A group has no roles of its own - the one thing there is to say
            // about somebody in one is whether the group is theirs.
            member.userId === ownerId && member.role === "member"
                ? { ...member, role: "owner" }
                : member
        );
        return rows.sort(
            (left, right) =>
                (RANK[left.role] ?? 9) - (RANK[right.role] ?? 9) ||
                left.name.localeCompare(right.name)
        );
    }, [members, ownerId]);

    return { members: sorted, loading: members === null };
}

function MemberRows({
    members,
    loading,
    viewerId,
    channel,
    onMention,
    onChanged
}: {
    members: readonly ChatMemberView[];
    loading: boolean;
    viewerId: string;
    /** The room being looked at, which is what decides who may do what to whom -
     *  see `MemberMenu`. */
    channel: ChatChannelView;
    onMention: (text: string) => void;
    onChanged: () => void;
}) {
    const [error, setError] = useState("");
    const direct = useOpenDirect(setError);
    /** Whose nickname is being changed. Held here rather than in the menu: the
     *  menu is unmounted the moment an item is chosen, and a dialog opened by
     *  something that is about to disappear never appears. */
    const [naming, setNaming] = useState<MenuPerson | null>(null);

    if (loading) {
        return (
            <div className="flex flex-col gap-2 p-3" aria-hidden="true">
                {[0, 1, 2, 3].map((row) => (
                    <div key={row} className="flex items-center gap-2">
                        <Skeleton className="size-7 rounded-full" />
                        <Skeleton className="h-3 w-24" />
                    </div>
                ))}
            </div>
        );
    }

    return (
        <>
            {error && (
                <p role="alert" className="px-3 pt-2 text-xs text-danger">
                    {error}
                </p>
            )}
            <ul className="flex flex-col gap-0.5 p-2">
                {members.map((member) => (
                    <MemberRow
                        key={member.userId}
                        member={member}
                        you={member.userId === viewerId}
                        channel={channel}
                        viewerId={viewerId}
                        busy={direct.busy}
                        onOpen={() => void direct.open(member.userId)}
                        onMention={onMention}
                        onNickname={setNaming}
                        onChanged={onChanged}
                        onError={setError}
                    />
                ))}
            </ul>

            <NicknameDialog
                open={naming !== null}
                person={naming ? { id: naming.userId, name: naming.name } : null}
                onOpenChange={(open) => !open && setNaming(null)}
                onSaved={onChanged}
            />
        </>
    );
}

/**
 * One person in the roster.
 *
 * Its own component because it reads presence, and presence is per person: a
 * hook inside the loop above would be a hook called a different number of times
 * whenever somebody joins the room.
 */
function MemberRow({
    member,
    you,
    channel,
    viewerId,
    busy,
    onOpen,
    onMention,
    onNickname,
    onChanged,
    onError
}: {
    member: ChatMemberView;
    you: boolean;
    channel: ChatChannelView;
    viewerId: string;
    busy: boolean;
    onOpen: () => void;
    onMention: (text: string) => void;
    onNickname: (person: MenuPerson) => void;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const role = ROLE_WORDS[member.role];
    // What they are showing right now. Already on screen for the avatar's dot,
    // so this costs nothing: the store asked about them either way.
    const where = usePresence(member.userId);
    // The line wins over the role when there is one. A role is a fact that does
    // not change; a status is what somebody is doing this afternoon, and two
    // lines under a name in a 14rem column is a wall.
    const under = where?.note || role;
    return (
                        <li key={member.userId}>
                            <MemberMenu
                                member={member}
                                channel={channel}
                                viewerId={viewerId}
                                onMention={onMention}
                                onNickname={onNickname}
                                onChanged={onChanged}
                                onError={onError}
                            >
                            <button
                                type="button"
                                disabled={you || busy}
                                title={you ? member.name : `Message ${member.name}`}
                                onClick={onOpen}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
                                    you ? "cursor-default" : "hover:bg-card-hover disabled:opacity-70"
                                )}
                            >
                                <Avatar
                                    person={{ id: member.userId, name: member.name }}
                                    size={28}
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1">
                                        <span className="truncate text-sm">
                                            {member.name}
                                            {you && <span className="text-muted-foreground"> (you)</span>}
                                        </span>
                                        {member.role === "owner" && (
                                            <Crown
                                                role="img"
                                                aria-label="Owner"
                                                className="size-3.5 text-warning"
                                            />
                                        )}
                                    </span>
                                    {under && (
                                        <span
                                            className="block truncate text-[0.6875rem] text-muted-foreground"
                                            title={under}
                                        >
                                            {under}
                                        </span>
                                    )}
                                </span>
                            </button>
                            </MemberMenu>
                        </li>
    );
}

/**
 * The roster, as a column beside the conversation or as a dialog over it.
 *
 * Which one is not a preference: a 14rem column beside a 4rem conversation
 * helps nobody, so below the breakpoint where the two fit the same list is a
 * dialog. One component decides it, because it is one question with one answer
 * and two shapes.
 */
export function ChannelMembers({
    channel,
    open,
    onOpenChange,
    onMention
}: {
    channel: ChatChannelView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Put somebody into what is being written. The composer owns the box, so
     *  this only says what to drop in it - see `MemberMenu`. */
    onMention: (text: string) => void;
}) {
    const { viewerId, refresh } = useChat();
    const wide = useWideScreen();
    const { members, loading } = useRoster(channel.id, channel.ownerId, open);
    const heading = `Members${loading ? "" : ` - ${members.length}`}`;

    if (!open) return null;

    if (!wide) {
        return (
            <Dialog open onOpenChange={onOpenChange}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Users className="size-4 text-muted-foreground" />
                            {heading}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="max-h-[60vh] overflow-y-auto">
                        <MemberRows
                            members={members}
                            loading={loading}
                            viewerId={viewerId}
                            channel={channel}
                            onMention={onMention}
                            onChanged={refresh}
                        />
                    </div>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        // A little wider than it was and still narrower than the profile beside
        // a direct message: this is a list of names, which wraps badly and reads
        // fine narrow, where that one carries sentences. Every pixel either
        // takes comes off the conversation, so the wider step waits for a window
        // with room for it - the same breakpoint the profile uses.
        <aside className="flex w-60 shrink-0 flex-col border-l border-border xl:w-64">
            <div className="flex h-header shrink-0 items-center justify-between gap-2 border-b border-border px-3">
                <span className="text-sm font-semibold">{heading}</span>
                <button
                    type="button"
                    aria-label="Hide the members"
                    onClick={() => onOpenChange(false)}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-4" />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <MemberRows
                    members={members}
                    loading={loading}
                    viewerId={viewerId}
                    channel={channel}
                    onMention={onMention}
                    onChanged={refresh}
                />
            </div>
        </aside>
    );
}
