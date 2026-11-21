"use client";

/**
 * How a space looks wherever it is named: its initials in its own colour, with
 * the picture whoever runs it put on it drawn over them.
 *
 * The server rail drew this and every other list that named a space drew a
 * generic server glyph instead, so the forward dialog listed four identical
 * icons for four servers somebody tells apart at a glance in the column. One
 * face, read from the same pieces, so a space is recognisable wherever it shows.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { chatAvatarUrl } from "@/lib/avatar-url";
import type { ChatSpaceView } from "@/lib/chat/chat-service";

/** A stored colour as `#rrggbb`, or null when it is not one this can draw with.
 *  The column is a free string, so a space could hold anything at all. */
export function spaceColor(color: string | undefined): string | null {
    if (!color) return null;
    const trimmed = color.trim();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
    if (short)
        return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Up to two letters, taken from the words of the name. */
export function spaceInitials(space: Pick<ChatSpaceView, "name">): string {
    const words = space.name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
    return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/**
 * The picture whoever runs the space put on it, over its initials.
 *
 * Nothing here knows whether there is one: the route answers a transparent pixel
 * when there is not, and the letters underneath show straight through it. So the
 * common case draws no request-shaped hole and needs no query to decide what to
 * render.
 */
export function SpacePicture({ spaceId }: { spaceId: string }) {
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

/** A small, still tile of a space for a row in a list. Decorative: the row next
 *  to it already says the name. */
export function SpaceFace({
    space,
    className
}: {
    space: Pick<ChatSpaceView, "id" | "name" | "color">;
    className?: string;
}) {
    const color = spaceColor(space.color);
    return (
        <span
            aria-hidden="true"
            style={
                color
                    ? // The rail's two alphas of the space's own colour, so the
                      // tile reads as the same space in both themes.
                      { backgroundColor: `${color}1f`, borderColor: `${color}66`, color }
                    : undefined
            }
            className={cn(
                "relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border text-[0.625rem] font-semibold",
                !color && "border-border bg-card text-muted-foreground",
                className
            )}
        >
            {spaceInitials(space)}
            <SpacePicture spaceId={space.id} />
        </span>
    );
}
