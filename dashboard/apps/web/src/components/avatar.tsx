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
import { Volume2 } from "lucide-react";
import { createPortal } from "react-dom";
import { ImageViewer } from "@/components/image-viewer";
import { usePresence } from "@/components/presence-store";
import { avatarUrl, orgAvatarUrl } from "@/lib/avatar-url";
import { usePhotoOpenable } from "@/components/photo-access";
import { PRESENCE_WORDS, type Presence } from "@polaris/core";

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
 * The colour behind somebody's initials, and the fallback for the band across
 * their profile.
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
 *
 * Exported because a profile with no banner falls back to it - somebody whose
 * face is initials should not get a band in a colour they are not associated
 * with anywhere else. See `ProfileBanner`.
 */
export function tintFor(id: string): string {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
        hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} 36% 42%)`;
}

/**
 * Whether a face offers to open the photo behind it.
 *
 * Three things have to hold, and each of them is a different way of being wrong:
 * the screen has to have asked for it, there has to be a picture rather than
 * initials, and the person has to allow this reader to open it. Written out here
 * so the rule can be read and tested on its own - it is the one part of a face
 * that answers to somebody's privacy setting, and "the button was there but did
 * nothing" and "the button was there and should not have been" are both bugs
 * nobody would report.
 */
export function photoOpens(input: {
    readonly openable: boolean;
    readonly hasPhoto: boolean;
    readonly allowed: boolean;
    readonly source: string | null;
}): boolean {
    return input.openable && input.hasPhoto && input.allowed && input.source !== null;
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
    square = false,
    status = true,
    presence,
    openable = false
}: {
    person: AvatarPerson;
    size?: number;
    className?: string;
    /**
     * Where they are, when the caller already knows better than the store does.
     *
     * For somebody sitting in a call, chiefly. Being in the room is the strongest
     * statement of presence there is - stronger than anything the store keeps -
     * and it is the only one available for a guest, who has no account for the
     * store to have heard of. Without this their face was the one in the room
     * with no dot at all, which reads as "nobody knows" rather than as "they are
     * right here".
     */
    presence?: Presence;
    /**
     * Whether pressing the face opens the photo full size.
     *
     * Off by default, and on where the face stands for the person rather than
     * decorating a row: a conversation, a member list, somebody's profile. A face
     * inside something else that is already pressable stays a picture, because
     * two things under one press is one of them nobody finds.
     *
     * On its own it only offers: the press appears when there is a photo to open
     * - the blank pixel served for an account without one is not one - and when
     * that person's privacy setting lets this reader open it.
     */
    openable?: boolean;
    /** A rounded square instead of a circle. What an organization gets: a group
     *  and a person appear side by side in the same lists, and the shape is what
     *  tells them apart before either name is read. */
    square?: boolean;
    /**
     * Whether to draw the dot that says where they are, and the badge that says
     * they are on a call.
     *
     * On by default and everywhere, which is the point: knowing whether somebody
     * is at their desk is worth as much beside their name on a task as it is in
     * a conversation, and a status that only exists in the chat is a status
     * nobody trusts. Off where the face is not a person - an organization - and
     * where one is drawn at a size the dot would swallow.
     */
    status?: boolean;
}) {
    const source = person.image ?? (person.id ? avatarUrl(person.id) : null);
    // Nothing is asked when the caller has already answered - and a guest has no
    // id to ask about in the first place.
    const known = usePresence(presence || !status || square ? null : person.id);
    const where = presence ? { status: presence, inCall: false } : known;
    // A 404 is the ordinary answer for somebody with no picture anywhere, so it
    // is not an error state - it just means the initials underneath stay.
    const [failed, setFailed] = useState(false);
    // Whether there is a picture here at all. An account without one is answered
    // with a transparent pixel rather than a refusal, so the picture that arrived
    // is the one thing that says which happened - and a face showing initials
    // must not offer to open them.
    const [real, setReal] = useState(false);
    const [opened, setOpened] = useState(false);
    const mayOpen = usePhotoOpenable(openable ? person.id : null);
    const opens = photoOpens({ openable, hasPhoto: real, allowed: mayOpen, source });
    const shape = square ? "rounded-md" : "rounded-full";

    // The dot sits outside the picture, so it is not clipped by the circle the
    // face is cut into - which is why the face has a wrapper at all when there
    // is something to say about where somebody is.
    const face = (
        <span
            title={person.name}
            // Says this picture is a person rather than something in the page.
            // A menu that offers "copy image" over everything with an <img> in
            // it offers it over every face in the room, where what somebody
            // right-clicking a face wants is the person - see `messageTarget`.
            data-avatar=""
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
            {/* Underneath until there is something to put over them, and then
                gone. Not merely covered: a logo saved as a PNG with a
                transparent background is exactly the picture somebody uploads
                for an organization, and the initials read straight through it -
                "DY" printed across a mark, on every screen that draws one. A
                picture that loaded is the answer to what this face shows, so the
                letters stop being the answer. */}
            {real && !failed ? null : initials(person.name)}
            {source && !failed && (
                // eslint-disable-next-line @next/next/no-img-element -- one small image per person, no loader wanted
                <img
                    src={source}
                    alt=""
                    onError={() => setFailed(true)}
                    // The blank pixel is one pixel across, so this is the whole
                    // test for "is there a photo behind this face" and it costs
                    // no request of its own.
                    onLoad={(event) => setReal(event.currentTarget.naturalWidth > 1)}
                    className={cn("absolute inset-0 size-full object-cover", shape)}
                />
            )}
        </span>
    );

    // Pressable only where there is something to open. The button wraps the face
    // rather than replacing it, so the circle, the ring and the tint are the same
    // ones every other face has - a photo somebody can open must not be a
    // different-looking face.
    const shown = opens ? (
        <button
            type="button"
            aria-label={`Open ${person.name}'s photo`}
            className={cn("inline-flex shrink-0 cursor-zoom-in", shape)}
            onClick={(event) => {
                // The face often sits inside a row that opens something of its
                // own. Opening the photo is the whole gesture, not the first half
                // of two.
                event.preventDefault();
                event.stopPropagation();
                setOpened(true);
            }}
        >
            {face}
        </button>
    ) : (
        face
    );

    // Put on the body rather than beside the face: the viewer covers the window,
    // and a face sits inside scrolling panels and transformed rows that a fixed
    // child would be positioned and clipped by.
    const viewer =
        opened && source && typeof document !== "undefined"
            ? createPortal(
                  <ImageViewer
                      image={{ url: source, name: person.name }}
                      onClose={() => setOpened(false)}
                  />,
                  document.body
              )
            : null;

    // Nothing until it is known: a grey dot that turns green a moment later
    // reads as somebody's status changing rather than as an answer arriving.
    // And nothing on a face too small to carry one - below this the dot is
    // larger than the initials it covers.
    if (!where || size < PRESENCE_FLOOR) {
        return viewer ? (
            <>
                {shown}
                {viewer}
            </>
        ) : (
            shown
        );
    }

    return (
        // `h-fit`, and it is load-bearing. This wrapper is often a flex item -
        // a face beside a message, a name, a row of text - and a flex item with
        // an automatic cross size is stretched to the tallest thing beside it.
        // The face inside kept its size, so nothing looked wrong until the dot,
        // which hangs off the wrapper's bottom edge: beside a three-line message
        // it was drawn three lines below the face it belongs to. A definite
        // height is not stretched.
        <span className="relative inline-flex h-fit shrink-0 align-middle">
            {shown}
            {viewer}
            {where.inCall ? (
                // A call they are in and this reader could walk into. It takes
                // the dot's place rather than sitting beside it: somebody on a
                // call is by definition here, and two marks on one face is a
                // face nobody reads.
                <span
                    aria-label="On a call you can join"
                    title="On a call you can join"
                    className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-background ring-1 ring-background"
                    style={{ width: dotSize(size) + 3, height: dotSize(size) + 3 }}
                >
                    <Volume2 className="size-full p-px text-success" />
                </span>
            ) : (
                <span
                    aria-label={PRESENCE_WORDS[where.status]}
                    title={PRESENCE_WORDS[where.status]}
                    className={cn(
                        "absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-background",
                        PRESENCE_COLOURS[where.status]
                    )}
                    style={{ width: dotSize(size), height: dotSize(size) }}
                />
            )}
        </span>
    );
}

/** Below this a face is smaller than the dot would need to be legible on, so it
 *  goes without one rather than wearing a blob. */
const PRESENCE_FLOOR = 20;

/** A fifth of the face, floored so the smallest one is still a dot. */
function dotSize(size: number): number {
    return Math.max(8, Math.round(size * 0.28));
}

const PRESENCE_COLOURS: Record<Presence, string> = {
    online: "bg-success",
    idle: "bg-warning",
    busy: "bg-danger",
    // Drawn rather than omitted: an absent dot is "not asked yet", and the two
    // must not look the same.
    offline: "bg-border-strong"
};

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
                    className="inline-flex items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground ring-1 ring-border"
                    style={{ width: size, height: size }}
                >
                    +{people.length - shown.length}
                </span>
            )}
        </span>
    );
}
