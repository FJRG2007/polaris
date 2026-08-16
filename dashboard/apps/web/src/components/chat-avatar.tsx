"use client";

/**
 * The face of a space or a conversation.
 *
 * Three answers, in order, and the point is that the first two are drawn without
 * asking anybody: the initials in the thing's own colour, then - for a group -
 * the faces of the people in it, then the picture its owner uploaded, laid over
 * the top once it arrives. A list of groups is readable before any of them are
 * named and before a single request has come back.
 *
 * The faces are a mosaic inside one circle rather than a row of circles, because
 * this is drawn in a 18px slot beside a name: a row would be three times the
 * width of everything else in the column. Three of them, and the fourth cell
 * counts whoever did not fit - which is what makes a group of nine read as nine
 * rather than as three.
 */

import { cn } from "@polaris/ui";
import { useState } from "react";
import { chatAvatarUrl } from "@/lib/avatar-url";
import { Avatar, initials, type AvatarPerson } from "@/components/avatar";

/** How many faces fit in the mosaic before the last cell becomes a count. */
const CELLS = 4;

/**
 * The colour behind the initials.
 *
 * The same idea as an account's, and deliberately the same function shape: a
 * conversation with no picture still has to look like somebody chose it. A space
 * carries its own colour, so that one is passed in instead.
 */
function tintFor(id: string): string {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
        hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} 30% 40%)`;
}

export function ChatAvatar({
    kind,
    id,
    name,
    members = [],
    color,
    size = 24,
    square = false,
    className
}: {
    kind: "space" | "channel";
    id: string;
    name: string;
    /** Who is in it, for a conversation with no picture of its own. Empty for a
     *  space, whose initials and colour are what it is known by. */
    members?: readonly AvatarPerson[];
    /** A space's own colour, when it has one. */
    color?: string | null;
    size?: number;
    /** A rounded square rather than a circle: what a space gets, so a room and a
     *  person are told apart before either name is read. */
    square?: boolean;
    className?: string;
}) {
    // A transparent pixel is the answer when there is no picture and when the
    // reader is not in the thing, so a successful load is not proof of one -
    // whatever is underneath simply shows through it.
    const [failed, setFailed] = useState(false);
    const shape = square ? "rounded-md" : "rounded-full";
    const faces = members.slice(0, members.length > CELLS ? CELLS - 1 : CELLS);
    const spare = members.length - faces.length;

    return (
        <span
            title={name}
            className={cn(
                "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-medium text-white ring-1 ring-border",
                shape,
                className
            )}
            style={{
                width: size,
                height: size,
                fontSize: Math.max(9, Math.round(size * 0.4)),
                backgroundColor: color || tintFor(id)
            }}
        >
            {initials(name)}

            {faces.length > 1 && (
                <span
                    className="absolute inset-0 grid"
                    style={{
                        gridTemplateColumns: "1fr 1fr",
                        // Two people are two halves; three or more fill a square
                        // of four, so nothing is ever a lone face in a corner.
                        gridTemplateRows: faces.length === 2 ? "1fr" : "1fr 1fr"
                    }}
                >
                    {faces.map((person) => (
                        <Avatar
                            key={person.id ?? person.name}
                            person={person}
                            size={size}
                            square
                            className="size-full rounded-none ring-0"
                        />
                    ))}
                    {spare > 0 && (
                        <span
                            className="flex items-center justify-center bg-muted text-muted-foreground"
                            style={{ fontSize: Math.max(8, Math.round(size * 0.3)) }}
                        >
                            +{spare}
                        </span>
                    )}
                </span>
            )}

            {!failed && (
                // eslint-disable-next-line @next/next/no-img-element -- one small image, no loader wanted
                <img
                    src={chatAvatarUrl(kind, id)}
                    alt=""
                    onError={() => setFailed(true)}
                    className={cn("absolute inset-0 size-full object-cover", shape)}
                />
            )}
        </span>
    );
}
