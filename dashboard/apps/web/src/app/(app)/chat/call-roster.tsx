"use client";

/**
 * Who is in a call, for the people who are not.
 *
 * Read from the seats Polaris keeps, never from the media server: somebody
 * looking at a conversation is not connected to the call, cannot hear it and is
 * not sent a frame of it - they are only told who is sitting there, and whether
 * each of them has their microphone or their headphones off.
 */

import { Avatar } from "@/components/avatar";
import { HeadphoneOff, MicOff } from "lucide-react";
import type { VoicePresence } from "@/lib/chat/meetings";
import { PersonName, PersonRow } from "@/components/person-name";

type Seated = Pick<VoicePresence, "muted" | "deafened">;

/** The mark a face in a call wears. Deafened wins: it silences the microphone
 *  as well, and one mark is all there is room for. */
export function callBadgeOf(person: Seated): "muted" | "deafened" | null {
    return person.deafened ? "deafened" : person.muted ? "muted" : null;
}

/** The same mark as icons after a name, for a row too small to badge a face. */
export function VoiceStateIcons({ person }: { person: Seated }) {
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
                </PersonRow>
            ))}
        </ul>
    );
}
