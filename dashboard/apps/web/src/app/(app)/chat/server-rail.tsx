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

import { cn } from "@polaris/ui";
import { useChat } from "./chat-context";
import { useMemo, useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { NewSpaceDialog } from "./new-space-dialog";
import type { ChatSpaceView } from "@/lib/chat/chat-service";

/** A stored colour as `#rrggbb`, or null when it is not one this can draw with.
 *  The column is a free string, so a space could hold anything at all. */
function hex(color: string | undefined): string | null {
    if (!color) return null;
    const trimmed = color.trim();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function ServerRail() {
    const { spaces, channels, activeSpaceId, setActiveSpaceId, refresh } = useChat();
    const [newSpace, setNewSpace] = useState(false);

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
                onClick={() => setActiveSpaceId(null)}
            >
                <MessageSquare className="size-4" />
            </Pill>

            <span className="h-px w-6 shrink-0 bg-border" />

            <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto no-scrollbar">
                {spaces.map((space) => (
                    <Pill
                        key={space.id}
                        label={space.name}
                        active={activeSpaceId === space.id}
                        unread={waiting.get(space.id) ?? 0}
                        color={hex(space.color)}
                        onClick={() => setActiveSpaceId(space.id)}
                    >
                        {initials(space)}
                    </Pill>
                ))}
            </div>

            <button
                type="button"
                aria-label="New space"
                title="New space"
                onClick={() => setNewSpace(true)}
                className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors duration-fast hover:border-border-strong hover:bg-card-hover hover:text-foreground"
            >
                <Plus className="size-4" />
            </button>

            {/* Creating a space posts nothing, so nothing would tell the rail
                about it. Asking again is what puts it in the column. */}
            <NewSpaceDialog open={newSpace} onOpenChange={setNewSpace} onCreated={refresh} />
        </div>
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
 */
function Pill({
    label,
    active,
    unread,
    color,
    onClick,
    children
}: {
    label: string;
    active: boolean;
    unread: number;
    /** The space's own colour as `#rrggbb`, already checked. Direct messages
     *  have none: they are not a space and borrow no identity. */
    color?: string | null;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <span className="relative flex shrink-0 items-center">
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
                    "flex size-9 items-center justify-center overflow-hidden border text-xs font-semibold transition-all duration-fast",
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
}

/** Up to two letters, taken from the words of the name. */
function initials(space: ChatSpaceView): string {
    const words = space.name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
    return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}
