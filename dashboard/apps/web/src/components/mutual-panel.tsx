"use client";

/**
 * What you and somebody else have in common.
 *
 * Drawn in both places a profile is drawn - the page and the panel beside a
 * direct message - because they are the same profile and a second version of
 * this would be a second answer to the same question.
 *
 * The count is the point and the faces are the illustration. "Three friends in
 * common" is what turns a name into somebody you have simply not met yet; the
 * faces beside it are what make it worth reading, and a list of forty would be
 * neither.
 *
 * Faces overlapping in a row rather than stacked down one, which is what every
 * client that shows this does and is not decoration: a column of rows reads as a
 * directory to be gone through, and this is a fact about the person whose
 * profile it is. It is one line, so it can sit under a name without pushing
 * everything else off the panel, and the names are still there - under the
 * pointer, and read out to anybody who is not using one.
 *
 * Nothing is drawn when there is nothing in common. A heading over "none" is a
 * line that tells the reader something they did not ask and cannot act on.
 */

import Link from "next/link";
import { Hash, Users } from "lucide-react";
import { AvatarStack } from "@/components/avatar";
import { PersonName, PersonRow } from "@/components/person-name";

export interface MutualPanelProps {
    readonly friends: {
        readonly people: readonly { id: string; name: string; username: string }[];
        readonly total: number;
    };
    readonly spaces: {
        readonly spaces: readonly { id: string; name: string; color: string }[];
        readonly total: number;
    };
    /** Tighter, for the column beside a conversation. */
    readonly compact?: boolean;
}

export function MutualPanel({ friends, spaces, compact = false }: MutualPanelProps) {
    if (friends.total === 0 && spaces.total === 0) return null;

    return (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
            {friends.total > 0 ? (
                <div className="flex flex-col gap-1.5">
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <Users className="size-3.5 shrink-0" />
                        {friends.total === 1 ? "1 friend in common" : `${friends.total} friends in common`}
                    </p>
                    <div className="flex items-center gap-2 px-1.5">
                        {/* The faces, and then the names in writing. The stack
                            carries the count itself, so nothing here says "and 3
                            more" underneath a row that already said "+3". */}
                        <AvatarStack
                            size={compact ? 20 : 24}
                            max={compact ? 3 : 5}
                            total={friends.total}
                            people={friends.people}
                        />
                        <p className="min-w-0 flex-1 truncate text-sm">
                            {friends.people.map((person, index) => (
                                <span key={person.id}>
                                    {index > 0 ? <span className="text-muted-foreground">, </span> : null}
                                    <Link
                                        href={`/u/${person.username}`}
                                        className="transition-colors hover:text-foreground"
                                    >
                                        <PersonRow personId={person.id} as="span">
                                            <PersonName id={person.id} name={person.name} />
                                        </PersonRow>
                                    </Link>
                                </span>
                            ))}
                        </p>
                    </div>
                </div>
            ) : null}

            {spaces.total > 0 ? (
                <div className="flex flex-col gap-1.5">
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <Hash className="size-3.5 shrink-0" />
                        {spaces.total === 1 ? "1 space in common" : `${spaces.total} spaces in common`}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                        {spaces.spaces.map((space) => (
                            <li
                                key={space.id}
                                className="flex items-center gap-2 px-1.5 py-1 text-sm"
                            >
                                {/* The dot the rail draws it by, so a space is
                                    recognised here the way it is there. */}
                                <span
                                    aria-hidden
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ background: space.color }}
                                />
                                <span className="min-w-0 flex-1 truncate" title={space.name}>
                                    {space.name}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {spaces.total > spaces.spaces.length ? (
                        <p className="text-muted-foreground px-1.5 text-xs">
                            and {spaces.total - spaces.spaces.length} more
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
