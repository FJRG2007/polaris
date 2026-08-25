"use client";

/**
 * The column of spaces, left of everything.
 *
 * The shape every chat client with servers in it has settled on, and for a
 * reason worth stating: the number of spaces somebody is in is small and stable,
 * while the number of conversations inside one is neither. Putting the spaces in
 * their own fixed column means switching between them is one click at a position
 * that never moves, and the list beside it is only ever one space deep.
 *
 * Direct messages sit at the top as a space of their own, because that is what
 * they behave like - a place you go, holding conversations - even though they
 * belong to no space at all.
 *
 * A space is drawn as its initials in its own colour rather than an icon nobody
 * chose. Two spaces with the same initials are told apart by the colour, and
 * neither needs anybody to have uploaded anything.
 *
 * The colour is a tint rather than a fill: the tile keeps the border and the
 * card surface every other panel in Polaris has, and the space's colour is spent
 * on the letters and the edge. A column of six saturated squares is the one
 * thing on the screen shouting, and it is furniture - the same reason the token
 * file keeps the violet for the few places that earn it. It also means a space
 * whose colour somebody set to a pale yellow is still readable, which a block of
 * that colour with white letters on it is not.
 */

import { useChat } from "./chat-context";
import { forwardRef, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import { lastChannelIn } from "./recents";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { LeaveDialog } from "./leave-dialog";
import * as core from "@polaris/core";
import { leaveSpaceAction, setSpaceNotifyAction } from "./actions";
import { BansDialog } from "./bans-dialog";
import { InviteDialog } from "./invite-dialog";
import { chatAvatarUrl } from "@/lib/avatar-url";
import { NewSpaceDialog } from "./new-space-dialog";
import { ChatPictureDialog } from "./picture-dialog";
import { NewChannelDialog } from "./new-channel-dialog";
import { NotifyOptions } from "./notify-menu";
import type { MenuParts } from "./mute-menu";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import { Ban, Hash, Image as ImageIcon, LogOut, MessageSquare, Plus, UserPlus } from "lucide-react";
import {
    cn,
    useToast,
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

/** How the shared notification list draws itself inside a right-click menu. */
const CONTEXT_PARTS: MenuParts = {
    Item: ContextMenuItem,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent
};

/** A stored colour as `#rrggbb`, or null when it is not one this can draw with.
 *  The column is a free string, so a space could hold anything at all. */
function hex(color: string | undefined): string | null {
    if (!color) return null;
    const trimmed = color.trim();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
    if (short)
        return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function ServerRail() {
    const router = useRouter();
    const { spaces, channels, activeSpaceId, setActiveSpaceId, refresh, may } = useChat();
    const [newSpace, setNewSpace] = useState(false);
    const [newChannelIn, setNewChannelIn] = useState<ChatSpaceView | null>(null);
    const [inviting, setInviting] = useState<ChatSpaceView | null>(null);
    const [showingBans, setShowingBans] = useState<ChatSpaceView | null>(null);
    const [picturing, setPicturing] = useState<ChatSpaceView | null>(null);
    const [leaving, setLeaving] = useState<ChatSpaceView | null>(null);
    const [error, setError] = useState("");
    const toast = useToast();

    /**
     * A refusal, said where the reader is looking.
     *
     * The column is a strip of tiles with nowhere to write a line, and the one
     * piece of state here that holds a message is drawn inside the leave dialog
     * - so putting one there says nothing now and surfaces it later, attached to
     * the wrong question. A note is what this column has room for.
     */
    const announce = (message: string): void => {
        toast.show({ key: "space-notify", title: message });
    };

    /**
     * The standing answer for a whole space. A refusal comes back as a value
     * rather than as a throw, so it is read out of the result as well as caught.
     */
    const setNotify = async (
        spaceId: string,
        level: core.ChatChannelNotifyLevel
    ): Promise<void> => {
        const result = await runAction(() => setSpaceNotifyAction(spaceId, level), announce);
        if (result?.error) announce(result.error);
        refresh();
    };

    /**
     * Open a space, and a conversation inside it. Null is direct messages, which
     * behave like a space here and are reached the same way.
     *
     * Choosing one used to move the list on the left and leave the reader looking
     * at whatever was already open - a click that appears to do nothing, and
     * worse in the direction nobody expects: pressing Direct messages while
     * standing in a server listed the conversations and went on showing the
     * server's channel beside them.
     *
     * So it always lands somewhere: where this browser was last in that place,
     * then the newest conversation in it, then Chat with nothing open - which is
     * the honest answer for somebody who has never sent a direct message.
     *
     * A voice room is never it. Landing in one would put somebody in a call by
     * navigating, which is not what picking a server means.
     */
    const openSpace = (spaceId: string | null): void => {
        setActiveSpaceId(spaceId);
        const inSpace = channels.filter(
            (channel) =>
                channel.spaceId === spaceId && !channel.archived && channel.kind !== "voice"
        );
        const remembered = lastChannelIn(spaceId);
        const target =
            inSpace.find((channel) => channel.id === remembered) ??
            // A space has an order somebody arranged; the people you talk to have
            // none but "who spoke last", which is what the list beside this shows.
            (spaceId === null
                ? [...inSpace].sort((left, right) =>
                      (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
                  )[0]
                : inSpace[0]);
        router.push(target ? `/chat/c/${target.id}` : "/chat");
    };

    /** Unread, summed per space, so a space with something waiting says so
     *  without the list under it being open. */
    const waiting = useMemo(() => {
        const totals = new Map<string | null, number>();
        for (const channel of channels) {
            if (channel.muted || channel.unread === 0) continue;
            const key = channel.spaceId;
            totals.set(key, (totals.get(key) ?? 0) + channel.unread);
        }
        return totals;
    }, [channels]);

    return (
        <div className="flex h-full w-14 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface py-2">
            <Pill
                label="Direct messages"
                active={activeSpaceId === null}
                unread={waiting.get(null) ?? 0}
                onClick={() => openSpace(null)}
            >
                <MessageSquare className="size-4" />
            </Pill>

            <span className="h-px w-6 shrink-0 bg-border" />

            <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto no-scrollbar">
                {spaces.map((space) => (
                    <SpaceMenu
                        key={space.id}
                        space={space}
                        onNewChannel={() => {
                            openSpace(space.id);
                            setNewChannelIn(space);
                        }}
                        onInvite={() => setInviting(space)}
                        onBans={() => setShowingBans(space)}
                        onPicture={() => setPicturing(space)}
                        onLeave={() => setLeaving(space)}
                        onNotify={(level) => void setNotify(space.id, level)}
                    >
                        <Pill
                            label={space.name}
                            active={activeSpaceId === space.id}
                            unread={waiting.get(space.id) ?? 0}
                            color={hex(space.color)}
                            onClick={() => openSpace(space.id)}
                        >
                            {initials(space)}
                            <SpacePicture spaceId={space.id} />
                        </Pill>
                    </SpaceMenu>
                ))}
            </div>

            {/* Absent for an account that may not start one, rather than a
                button that opens a dialog to say no. */}
            {may.spaces && (
                <button
                    type="button"
                    aria-label="New space"
                    title="New space"
                    onClick={() => setNewSpace(true)}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors duration-fast hover:border-border-strong hover:bg-card-hover hover:text-foreground"
                >
                    <Plus className="size-4" />
                </button>
            )}

            {/* Creating a space posts nothing, so nothing would tell the rail
                about it. Asking again is what puts it in the column. */}
            <NewSpaceDialog open={newSpace} onOpenChange={setNewSpace} onCreated={refresh} />
            <NewChannelDialog
                space={newChannelIn}
                onOpenChange={(next: boolean) => !next && setNewChannelIn(null)}
            />
            <BansDialog
                space={showingBans}
                onOpenChange={(open) => !open && setShowingBans(null)}
            />

            <InviteDialog
                space={inviting}
                onOpenChange={(next: boolean) => !next && setInviting(null)}
            />
            {leaving && (
                <LeaveDialog
                    open
                    onOpenChange={(next: boolean) => !next && setLeaving(null)}
                    kind="space"
                    name={leaving.name}
                    error={error}
                    onLeave={async (quietly) => {
                        setError("");
                        const result = await runAction(
                            () => leaveSpaceAction(leaving.id, quietly),
                            setError
                        );
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        setLeaving(null);
                        // Back to the direct messages: the column is about to
                        // lose the space that is currently open, and a rail
                        // pointing at a space that is gone shows nothing.
                        setActiveSpaceId(null);
                        refresh();
                        router.push("/chat");
                    }}
                />
            )}
            {picturing && (
                <ChatPictureDialog
                    open
                    onOpenChange={(next: boolean) => !next && setPicturing(null)}
                    kind="space"
                    id={picturing.id}
                    name={picturing.name}
                    color={hex(picturing.color)}
                    // The tile is drawn from one URL that nothing on screen will
                    // ask for again by itself. The new bytes are already in the
                    // browser, so this is a redraw rather than a round trip.
                    onChanged={() => window.location.reload()}
                />
            )}
        </div>
    );
}

/**
 * The picture whoever runs the space put on it, over its initials.
 *
 * Nothing here knows whether there is one: the route answers a transparent pixel
 * when there is not, and the letters underneath show straight through it. So the
 * common case draws no request-shaped hole and needs no query to decide what to
 * render.
 */
function SpacePicture({ spaceId }: { spaceId: string }) {
    const [failed, setFailed] = useState(false);
    if (failed) return null;
    return (
        // eslint-disable-next-line @next/next/no-img-element -- one small image per space, no loader wanted
        <img
            src={chatAvatarUrl("space", spaceId)}
            alt=""
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-cover"
        />
    );
}

/**
 * One button in the column.
 *
 * The marker on the left edge says which one is open, because the tiles are all
 * one surface apart and a surface step alone is not a state anybody reads at a
 * glance down a narrow column. Radius does the rest: the open one is drawn
 * tighter than the others, which is the motion this pattern is known by, and
 * both steps are on the four-step scale rather than beyond it.
 *
 * It takes a ref and passes the rest of its props to its outer element, and that
 * is not decoration: the right-click menu wraps one of these with `asChild`,
 * which hands the child a ref and the handlers that open the menu. A plain
 * function component drops both silently, which is exactly what happened - every
 * space in the column had a menu that nothing could open.
 */
const Pill = forwardRef<
    HTMLSpanElement,
    {
        label: string;
        active: boolean;
        unread: number;
        /** The space's own colour as `#rrggbb`, already checked. Direct messages
         *  have none: they are not a space and borrow no identity. */
        color?: string | null;
        onClick: () => void;
        children: React.ReactNode;
    } & Omit<ComponentPropsWithoutRef<"span">, "color" | "onClick" | "children">
>(function Pill({ label, active, unread, color, onClick, children, ...rest }, ref) {
    return (
        <span {...rest} ref={ref} className="relative flex shrink-0 items-center">
            <span
                aria-hidden="true"
                className={cn(
                    "absolute -left-2 w-1 rounded-r-full bg-foreground transition-all duration-fast",
                    active ? "h-6" : unread > 0 ? "h-2" : "h-0"
                )}
            />
            <button
                type="button"
                onClick={onClick}
                aria-label={label}
                aria-current={active ? "true" : undefined}
                title={label}
                style={
                    color
                        ? // Two alphas of the space's own colour, over the card
                          // it would otherwise be. Hex rather than a token, so
                          // it stays the colour somebody chose in both themes.
                          { backgroundColor: `${color}1f`, borderColor: `${color}66`, color }
                        : undefined
                }
                className={cn(
                    "relative flex size-9 items-center justify-center overflow-hidden border text-xs font-semibold transition-all duration-fast",
                    active ? "rounded-md" : "rounded-lg",
                    color
                        ? "hover:brightness-125"
                        : cn(
                              "border-border bg-card",
                              active
                                  ? "border-border-strong text-foreground"
                                  : "text-muted-foreground hover:bg-card-hover hover:text-foreground"
                          )
                )}
            >
                {children}
            </button>
            {unread > 0 && (
                <span className="pointer-events-none absolute -bottom-0.5 -right-1 rounded-full bg-primary px-1 text-[10px] font-medium leading-4 text-primary-foreground">
                    {unread > 98 ? "99+" : unread}
                </span>
            )}
        </span>
    );
});

/**
 * Right-clicking a space.
 *
 * The things somebody does to a space rather than inside one: add a channel to
 * it, and let somebody else in. Both were reachable only from inside the space,
 * which meant switching to it first - and switching to a space is a decision to
 * read it, which is not what somebody sending an invitation is doing.
 *
 * What is offered depends on the seat: adding a channel is an administrator's,
 * and so is inviting into a private space, because a private space is one whose
 * roster was chosen. How loudly it may interrupt is nobody's but the reader's,
 * so it is offered to everybody and sits at the top - it is the one thing here
 * somebody comes back to.
 */
function SpaceMenu({
    space,
    onNewChannel,
    onInvite,
    onPicture,
    onBans,
    onLeave,
    onNotify,
    children
}: {
    space: ChatSpaceView;
    onNewChannel: () => void;
    onInvite: () => void;
    onPicture: () => void;
    onBans: () => void;
    onLeave: () => void;
    onNotify: (level: core.ChatChannelNotifyLevel) => void;
    children: React.ReactNode;
}) {
    const administers = space.access !== "member";
    const mayInvite = administers || space.visibility !== "private";
    // Leaving is only real where the roster is what lets somebody in. An
    // internal space is reachable by everybody who can see its owner, so
    // deleting a membership row there would take nothing away and the space
    // would still be in the column - an option that appears to do nothing is
    // worse than no option. The owner's way out is deleting it.
    const mayLeave = space.access !== "owner" && space.visibility === "private";

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-52">
                <ContextMenuLabel>{space.name}</ContextMenuLabel>
                <ContextMenuSeparator />
                {/* What every channel in the space follows unless it was given
                    an answer of its own. Not a mute: the unread marks go on
                    counting whatever is chosen here. */}
                <NotifyOptions
                    level={space.notifyLevel}
                    parts={CONTEXT_PARTS}
                    onChoose={onNotify}
                />
                {(mayInvite || administers || mayLeave) && <ContextMenuSeparator />}
                {mayInvite && (
                    <ContextMenuItem onSelect={onInvite}>
                        <UserPlus className="size-3.5" />
                        Invite people
                    </ContextMenuItem>
                )}
                {administers && (
                    <ContextMenuItem onSelect={onNewChannel}>
                        <Hash className="size-3.5" />
                        New channel
                    </ContextMenuItem>
                )}
                {administers && (
                    <ContextMenuItem onSelect={onPicture}>
                        <ImageIcon className="size-3.5" />
                        Space picture
                    </ContextMenuItem>
                )}
                {/* The one moderation decision that never ends on its own and
                    reminds nobody it was made. Without a list, letting somebody
                    back in means remembering a name nobody has seen for six
                    months. */}
                {administers && (
                    <ContextMenuItem onSelect={onBans}>
                        <Ban className="size-3.5" />
                        Kept out
                    </ContextMenuItem>
                )}
                {mayLeave && (
                    <>
                        {(mayInvite || administers) && <ContextMenuSeparator />}
                        <ContextMenuItem variant="danger" onSelect={onLeave}>
                            <LogOut className="size-3.5" />
                            Leave this space
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** Up to two letters, taken from the words of the name. */
function initials(space: ChatSpaceView): string {
    const words = space.name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
    return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}
