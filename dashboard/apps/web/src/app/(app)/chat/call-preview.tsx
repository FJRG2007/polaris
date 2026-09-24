"use client";

/**
 * The call, seen from outside it.
 *
 * A call in a conversation used to be one line of text above the messages, and
 * on a group of five people talking that line was the only sign anything was
 * happening at all - so a call in a direct message looked exactly like a
 * conversation nobody was in. This is what every client draws instead: the same
 * faces the call itself draws, at the same size, with the way in beside them.
 *
 * Nothing of the call reaches this browser. The faces come from the seats
 * Polaris keeps (see `call-roster`), which is why they carry a picture, a name,
 * whether that person is muted and whether they are sharing a screen, and
 * nothing else: no video, no sound, no way to watch the screen short of joining,
 * and nobody in the call is told anybody is looking.
 *
 * It can be put away, because a call somebody has decided not to join must not
 * take a third of their conversation for as long as it runs. Putting it away
 * leaves the one line that was there before - which is also the way back.
 */

import { Button } from "@polaris/ui";
import { LiveBadge, callBadgeOf } from "./call-roster";
import { Avatar } from "@/components/avatar";
import { Mic, Video, X } from "lucide-react";
import type { VoicePresence } from "@/lib/chat/meetings";
import { PersonName, PersonRow } from "@/components/person-name";

/** How big a face is here. The same as a call drawn as faces, so joining does
 *  not resize everybody. */
const AVATAR_SIZE = 72;

/** What the heading says about a call somebody is looking at from outside. */
export function callSummary(count: number): string {
    if (count <= 0) return "Call in progress";
    return count === 1 ? "1 person in the call" : `${count} people in the call`;
}

export function CallPreview({
    people,
    count,
    canJoin,
    busy = false,
    onJoin,
    onHide
}: {
    /** Who is sitting in it, with their microphone and headphones as they last
     *  reported them. */
    people: readonly VoicePresence[];
    count: number;
    /** Whether the way in may be offered at all - calls can be switched off. */
    canJoin: boolean;
    busy?: boolean;
    onJoin: (withVideo: boolean) => void;
    /** Put it away. The line it leaves behind is what brings it back. */
    onHide: () => void;
}) {
    return (
        // The same frame the call draws once somebody is in it - a band over the
        // conversation, the faces in the middle of it and the way in under
        // them - so joining changes what the band holds rather than what it
        // looks like.
        <section
            aria-label="Call in progress"
            className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3"
        >
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {callSummary(count)}
                </span>
                <button
                    type="button"
                    onClick={onHide}
                    aria-label="Hide the call"
                    title="Hide the call - it keeps going, and the conversation comes back"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-4" />
                </button>
            </div>

            {/* Bounded and scrolled, like the faces in the call itself: eight
                people wrap to a second row, and a band that grows with them
                takes the conversation this sits above. */}
            <ul className="flex max-h-44 flex-wrap items-start justify-center gap-x-4 gap-y-3 overflow-y-auto overscroll-contain">
                {people.map((person) => (
                    <PersonRow
                        as="li"
                        key={person.id}
                        personId={person.userId}
                        plate="never"
                        className="flex w-20 shrink-0 flex-col items-center gap-1"
                        title={person.name}
                    >
                        <Avatar
                            size={AVATAR_SIZE}
                            person={{ id: person.userId, name: person.name }}
                            callBadge={callBadgeOf(person)}
                        />
                        <span className="flex w-full items-center justify-center gap-1 text-xs">
                            <span className="min-w-0 truncate">
                                <PersonName id={person.userId} name={person.name} />
                            </span>
                            {person.streaming && <LiveBadge />}
                        </span>
                    </PersonRow>
                ))}
            </ul>

            {canJoin && (
                <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
                    <Button size="sm" disabled={busy} onClick={() => onJoin(false)}>
                        <Mic className="size-3.5" />
                        Join
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => onJoin(true)}
                    >
                        <Video className="size-3.5" />
                        With video
                    </Button>
                </div>
            )}
        </section>
    );
}

/**
 * The same call, once somebody has put the faces away.
 *
 * One line, and the way back on it. It is not merely a smaller version of the
 * panel: it is what says the call is still running to somebody who decided they
 * would rather read.
 */
export function CallPreviewLine({
    count,
    canJoin,
    busy = false,
    onJoin,
    onShow
}: {
    count: number;
    canJoin: boolean;
    busy?: boolean;
    onJoin: (withVideo: boolean) => void;
    onShow: () => void;
}) {
    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2">
            <span className="min-w-0 flex-1 truncate text-sm">{callSummary(count)}</span>
            <Button size="xs" variant="ghost" onClick={onShow}>
                Show
            </Button>
            {canJoin && (
                <Button size="xs" disabled={busy} onClick={() => onJoin(false)}>
                    <Mic className="size-3.5" />
                    Join
                </Button>
            )}
        </div>
    );
}
