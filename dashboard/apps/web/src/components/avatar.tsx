"use client";

/**
 * The face of a Polaris account, everywhere one is drawn.
 *
 * Initials are the base rather than the fallback: they render immediately and
 * the picture is laid over them once it arrives, so a list of people never
 * flashes empty circles and an account with no picture never flashes a broken
 * one. Every source ends at the same URL, so nothing here knows whether it is
 * about to show an upload, a Gravatar or nothing at all.
 *
 * Faces are drawn in lists, in menus, in a table and on a card, and a circle
 * that looks different in the table than on the board is how a workspace stops
 * feeling like one product - which is why this is one component rather than the
 * four near-copies it replaced.
 */

import { cn } from "@polaris/ui";
import { useState } from "react";
import { avatarUrl } from "@/lib/avatar-url";

export interface AvatarPerson {
    readonly id: string;
    readonly name: string;
    /** A picture from somewhere else (a linked GitHub account). Left unset for
     *  an ordinary Polaris account, whose picture is resolved from its id. */
    readonly image?: string | null;
}

/** Initials from a display name. Two words give two letters, one word gives two
 *  of its own, and something unnameable gives a question mark. */
export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return (parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts[1]![0]}`).toUpperCase();
}

export function Avatar({
    person,
    size = 24,
    className
}: {
    person: AvatarPerson;
    size?: number;
    className?: string;
}) {
    const source = person.image ?? avatarUrl(person.id);
    // A 404 is the ordinary answer for somebody with no picture anywhere, so it
    // is not an error state - it just means the initials underneath stay.
    const [failed, setFailed] = useState(false);

    return (
        <span
            title={person.name}
            className={cn(
                "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground ring-1 ring-border",
                className
            )}
            style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
        >
            {initials(person.name)}
            {!failed && (
                // eslint-disable-next-line @next/next/no-img-element -- one small image per person, no loader wanted
                <img
                    src={source}
                    alt=""
                    onError={() => setFailed(true)}
                    className="absolute inset-0 size-full rounded-full object-cover"
                />
            )}
        </span>
    );
}

/** Up to three faces and a "+n", which is as many as a row can carry legibly. */
export function AvatarStack({ people, size = 24 }: { people: readonly AvatarPerson[]; size?: number }) {
    if (people.length === 0) return null;
    const shown = people.slice(0, 3);
    return (
        <span className="flex items-center -space-x-1.5">
            {shown.map((person) => (
                <Avatar key={person.id} person={person} size={size} />
            ))}
            {people.length > shown.length && (
                <span
                    className="inline-flex items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-border"
                    style={{ width: size, height: size }}
                >
                    +{people.length - shown.length}
                </span>
            )}
        </span>
    );
}
