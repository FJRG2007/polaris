"use client";

/**
 * Who has their hand up, and in what order.
 *
 * The queue was worked out and never shown. Every browser in the call sorted the
 * same list from the moment each hand went up - see `handQueue` in
 * `call-signals` - and the only thing drawn from it was a twelve-pixel icon
 * tucked into the name plate of one tile, beside up to five other twelve-pixel
 * icons. Across a grid of eight faces that is not a raised hand; it is a hand
 * raised at nobody. Whoever was chairing could not tell who had asked to speak,
 * let alone who had asked first, which is the entire reason the gesture exists.
 *
 * So it is said in words, above the faces, where the call already says the other
 * things that are true right now - somebody waiting to be let in, a recording, a
 * room sharing one microphone. One hand is a sentence about a person, because
 * that is what it is. Several is a count and the queue itself, numbered, because
 * at three the question stops being who and becomes who is next.
 *
 * The chair can lower one, and anybody can lower their own. Lowering somebody
 * else's is a request their browser honours rather than something done to them -
 * see `call-signals`, which is also where the check that it came from the chair
 * lives.
 */

import type { CallState } from "./call-state";
import { Hand } from "lucide-react";
import { Button, ScrollRow } from "@polaris/ui";
import { handsSummary, type HandInQueue } from "./call-signals";
import { useMemo } from "react";

export function HandStrip({ call }: { call: CallState }) {
    const participants = call.meeting?.participants;
    const seat = call.participantId;
    /** The queue, named. Built once for the strip rather than looked up per
     *  chip, and in the order the call agreed on rather than in roster order. */
    const hands = useMemo<HandInQueue[]>(
        () =>
            call.hands.map((id) => ({
                id,
                // A seat with nobody behind it is somebody who has just left,
                // which reads better than an identifier nobody chose.
                name: participants?.find((person) => person.id === id)?.name ?? "Somebody",
                own: id === seat
            })),
        [call.hands, participants, seat]
    );

    /**
     * The announcement, mounted whether or not anybody has their hand up.
     *
     * A live region and its first content inserted in the same commit is a
     * mutation no screen reader was watching for, so the announcement most of
     * them drop is the first raised hand - the one this whole strip exists to
     * make noticeable. Kept in the tree and empty instead, so every hand going
     * up is a change to a region that was already there.
     *
     * Separate from the strip below rather than an attribute on it, because the
     * strip is also where the buttons live and a region that announces itself
     * every time a name is added or a chip is removed is one people switch off.
     */
    const announcement = (
        <span className="sr-only" role="status" aria-live="polite">
            {handsSummary(hands)}
        </span>
    );

    if (hands.length === 0) return announcement;

    const mine = hands.find((person) => person.own);
    /** The only hand up, when there is exactly one. Read this way rather than by
     *  index so a queue that emptied between the check and the button is nothing
     *  rather than a crash. */
    const only = hands.length === 1 ? hands[0] : undefined;

    return (
        <>
            {announcement}
            <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <Hand className="size-4 shrink-0 text-warning" />
                <span aria-hidden="true" className="shrink-0 font-medium">
                    {handsSummary(hands)}
                </span>

                {/* The queue itself, once there is one to read. Sideways rather than
                    wrapped: this sits above the faces in a panel that is often half a
                    screen tall, and a class of twenty hands wrapped over four lines
                    would push the call out of the window. */}
                {hands.length > 1 && (
                    <ScrollRow as="ol" className="flex min-w-0 flex-1 items-center gap-1">
                        {hands.map((person, index) => (
                            <li
                                key={person.id}
                                className="flex shrink-0 items-center gap-1 rounded-full bg-background/70 py-0.5 pl-1 pr-2"
                            >
                                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-warning text-[0.625rem] font-semibold text-warning-foreground">
                                    {index + 1}
                                </span>
                                <span className={person.own ? "font-medium" : undefined}>
                                    {person.own ? "You" : person.name}
                                </span>
                                {call.hosting && !person.own && (
                                    <button
                                        type="button"
                                        aria-label={`Lower ${person.name}'s hand`}
                                        title={`Lower ${person.name}'s hand`}
                                        onClick={() => call.lowerHand(person.id)}
                                        className="rounded-full px-1 text-muted-foreground transition-colors hover:text-foreground"
                                    >
                                        &times;
                                    </button>
                                )}
                            </li>
                        ))}
                    </ScrollRow>
                )}

                {/* One hand that is not yours, and you are chairing: the only thing
                    worth offering is the one thing you would do about it. */}
                {only && !only.own && call.hosting && (
                    <Button size="sm" variant="secondary" onClick={() => call.lowerHand(only.id)}>
                        Lower it
                    </Button>
                )}

                {mine && (
                    <Button size="sm" variant="secondary" onClick={() => call.setHandRaised(false)}>
                        Lower {hands.length > 1 ? "mine" : "my hand"}
                    </Button>
                )}

                {/* Clearing the room after a round of questions has been answered.
                    Eight hands lowered one chip at a time is eight presses on the
                    one person in the call who is also talking. */}
                {call.hosting && hands.length > 1 && (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => hands.forEach((person) => call.lowerHand(person.id))}
                    >
                        Lower all
                    </Button>
                )}
            </div>
        </>
    );
}
