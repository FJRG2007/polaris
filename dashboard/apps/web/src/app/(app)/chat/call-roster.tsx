"use client";

/**
 * Who is in a call, for the people who are not.
 *
 * Read from the seats Polaris keeps, never from the media server: somebody
 * looking at a conversation is not connected to the call, cannot hear it and is
 * not sent a frame of it - they are only told who is sitting there, whether
 * each of them has their microphone or their headphones off, and who is sharing
 * a screen.
 */

import { cn } from "@polaris/ui";
import { Avatar } from "@/components/avatar";
import { HeadphoneOff, MicOff } from "lucide-react";
import type { VoicePresence } from "@/lib/chat/meetings";
import { PersonName, PersonRow } from "@/components/person-name";

type Seated = Pick<VoicePresence, "muted" | "deafened"> &
    Partial<Pick<VoicePresence, "serverMuted" | "serverDeafened">>;

/** The mark a face in a call wears. Deafened wins: it silences the microphone
 *  as well, and one mark is all there is room for. */
export function callBadgeOf(person: Seated): "muted" | "deafened" | null {
    if (person.deafened || person.serverDeafened) return "deafened";
    return person.muted || person.serverMuted ? "muted" : null;
}

/**
 * Somebody is sharing a screen.
 *
 * A mark, not a way in: somebody outside the call is told a screen is up and is
 * not sent a frame of it. Watching it is joining the call and pressing it there.
 */
export function LiveBadge({ className }: { className?: string }) {
    return (
        <span
            role="img"
            aria-label="Sharing a screen"
            title="Sharing a screen"
            className={cn(
                "shrink-0 rounded bg-danger px-1 text-[0.625rem] font-bold uppercase leading-4 text-danger-foreground",
                className
            )}
        >
            Live
        </span>
    );
}

/** The same mark as icons after a name, for a row too small to badge a face. */
export function VoiceStateIcons({ person }: { person: Seated }) {
    // A moderator's mark outranks the person's own, and is drawn in the danger
    // colour the way every voice client draws it: it is the one they cannot
    // take off themselves.
    if (person.serverDeafened || person.serverMuted) {
        const Icon = person.serverDeafened ? HeadphoneOff : MicOff;
        const words = person.serverDeafened ? "Deafened by a moderator" : "Muted by a moderator";
        return (
            <span role="img" aria-label={words} title={words} className="ml-auto shrink-0">
                <Icon className="size-3 text-danger" />
            </span>
        );
    }
    const badge = callBadgeOf(person);
    if (!badge) return null;
    const Icon = badge === "deafened" ? HeadphoneOff : MicOff;
    const words = badge === "deafened" ? "Not listening" : "Microphone off";
    return (
        <span role="img" aria-label={words} title={words} className="ml-auto shrink-0">
            <Icon className="size-3 text-muted-foreground" />
        </span>
    );
}

/** The faces in a call, in the order they arrived, each with its mark. */
export function CallRoster({ people }: { people: readonly VoicePresence[] }) {
    if (people.length === 0) return null;
    return (
        <ul
            aria-label="In the call"
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
        >
            {people.map((person) => (
                <PersonRow
                    as="li"
                    key={person.id}
                    personId={person.userId}
                    className="flex min-w-0 items-center gap-1.5 text-xs"
                    title={person.name}
                >
                    <Avatar
                        size={24}
                        // A guest has no account, so no picture to ask for:
                        // the initials of the name they gave.
                        person={{ id: person.userId, name: person.name }}
                        callBadge={callBadgeOf(person)}
                    />
                    <span className="max-w-32 truncate">
                        <PersonName id={person.userId} name={person.name} />
                    </span>
                    {person.streaming && <LiveBadge />}
                </PersonRow>
            ))}
        </ul>
    );
}

/**
 * The same people, listed rather than lined up.
 *
 * A voice room is somewhere people are, so who is in it is a roster - and a
 * roster in Polaris is a column of rows: a face, a name, and whatever else is
 * true of that person. The chips above are for the places where the call is an
 * aside to something else being read; this is for the room itself, and it is
 * the row the rest of Polaris uses (the members column next door, the assignee
 * picker in Tasks) rather than a third shape.
 */
export function CallRosterList({
    people,
    label = "In this room"
}: {
    people: readonly VoicePresence[];
    /** What the list is called, for anybody who cannot see it. */
    label?: string;
}) {
    if (people.length === 0) return null;
    return (
        <ul aria-label={label} className="flex min-w-0 flex-col gap-0.5">
            {people.map((person) => (
                <PersonRow
                    as="li"
                    key={person.id}
                    personId={person.userId}
                    className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-sm"
                    title={person.name}
                >
                    <Avatar
                        size={24}
                        // A guest has no account, so no picture to ask for: the
                        // initials of the name they gave.
                        person={{ id: person.userId, name: person.name }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                        <PersonName id={person.userId} name={person.name} />
                    </span>
                    {person.streaming && <LiveBadge />}
                    <VoiceStateIcons person={person} />
                </PersonRow>
            ))}
        </ul>
    );
}
