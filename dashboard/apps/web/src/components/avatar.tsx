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
import { avatarUrl, orgAvatarUrl } from "@/lib/avatar-url";

export interface AvatarPerson {
    /**
     * The account this face belongs to, or null for somebody who has none - a
     * guest in a call, who has a name and nothing else. Null draws the initials
     * and asks for no picture: the tile used to pass the name in place of the
     * id, and every one of those became a request for the photo of an account
     * that does not exist.
     */
    readonly id: string | null;
    readonly name: string;
    /** A picture from somewhere else (a linked GitHub account). Left unset for
     *  an ordinary Polaris account, whose picture is resolved from its id. */
    readonly image?: string | null;
}

/**
 * The colour behind somebody's initials.
 *
 * Everybody used to get `bg-muted`, which is a surface token: hue 225, so a
 * whole column of faces came out the same faint blue and read as a UI element
 * that had failed to load rather than as a person. A face with no photo still
 * has to look deliberate.
 *
 * So the hue comes from the id - stable, so the same person is the same colour
 * on every screen and across sessions, and spread, so two people in a list are
 * tellable apart before their initials are read. Saturation and lightness are
 * fixed rather than derived: they are what keeps white text legible on all 360
 * of them, and what stops the palette turning into a bag of sweets.
 *
 * Fixed values rather than tokens because they must not move with the theme: the
 * initials are white on this in both, and a background that lightened for the
 * light theme would take the contrast with it.
 */
function tintFor(id: string): string {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
        hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} 36% 42%)`;
}

/** Initials from a display name. Two words give two letters, one word gives two
 *  of its own, and something unnameable gives a question mark. */
export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return (parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts[1]![0]}`).toUpperCase();
}

/**
 * The faces this browser has already been asked for, so asking again costs
 * nothing. Module level rather than component state: a menu that unmounts every
 * time it closes would forget it otherwise, and the point is to remember across
 * the open and close of whatever is showing the people.
 */
const requested = new Set<string>();

/**
 * Fetch a set of faces before anything draws them.
 *
 * A picker that mounts thirty avatars fires thirty requests as it appears, which
 * is the pause people see between opening a menu and being able to read it. Done
 * ahead of time - when the menu that will show them opens, not when its submenu
 * does - the pictures are already in the browser's cache by the time an <img>
 * asks for one, and the response carries a max-age so later screens reuse them.
 */
export function preloadAvatars(people: readonly AvatarPerson[]): void {
    if (typeof window === "undefined") return;
    for (const person of people) {
        const source = person.image ?? (person.id ? avatarUrl(person.id) : null);
        if (!source || requested.has(source)) continue;
        requested.add(source);
        const picture = new window.Image();
        picture.src = source;
    }
}

export function Avatar({
    person,
    size = 24,
    className,
    square = false
}: {
    person: AvatarPerson;
    size?: number;
    className?: string;
    /** A rounded square instead of a circle. What an organization gets: a group
     *  and a person appear side by side in the same lists, and the shape is what
     *  tells them apart before either name is read. */
    square?: boolean;
}) {
    const source = person.image ?? (person.id ? avatarUrl(person.id) : null);
    // A 404 is the ordinary answer for somebody with no picture anywhere, so it
    // is not an error state - it just means the initials underneath stay.
    const [failed, setFailed] = useState(false);
    const shape = square ? "rounded-md" : "rounded-full";

    return (
        <span
            title={person.name}
            className={cn(
                "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-medium text-white ring-1 ring-border",
                shape,
                className
            )}
            style={{
                width: size,
                height: size,
                fontSize: Math.max(9, Math.round(size * 0.4)),
                backgroundColor: tintFor(person.id ?? person.name)
            }}
        >
            {initials(person.name)}
            {source && !failed && (
                // eslint-disable-next-line @next/next/no-img-element -- one small image per person, no loader wanted
                <img
                    src={source}
                    alt=""
                    onError={() => setFailed(true)}
                    className={cn("absolute inset-0 size-full object-cover", shape)}
                />
            )}
        </span>
    );
}

/** An organization's face, wherever one is drawn. The same component underneath,
 *  pointed at the organization's own picture and drawn as a square. */
export function OrgAvatar({
    org,
    size = 24,
    className
}: {
    org: { readonly id: string; readonly name: string };
    size?: number;
    className?: string;
}) {
    return (
        <Avatar
            square
            size={size}
            className={className}
            person={{ id: org.id, name: org.name, image: orgAvatarUrl(org.id) }}
        />
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
