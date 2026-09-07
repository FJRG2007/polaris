/**
 * The two things people say in a call without speaking: a hand, and a reaction.
 *
 * They look alike and are carried differently, and the difference is the whole
 * of this module.
 *
 * **A raised hand is a state.** It is true until it is lowered, which means it
 * has to reach somebody who joins afterwards - a hand up for four minutes that
 * is invisible to the person who arrived at minute two is a hand that does not
 * work. So it rides in a participant attribute, the small bag the call server
 * keeps per person and hands to everybody, including latecomers.
 *
 * **A reaction is an event.** It happened, it is on screen for three seconds,
 * and it is worth nothing afterwards - so it travels as a data message, which is
 * delivered to whoever is in the room and to nobody later. Putting it in an
 * attribute would leave everybody's last reaction pinned to their face for the
 * rest of the call, and would make two of the same in a row indistinguishable
 * from one.
 *
 * Pure, so both rules can be checked without a call server.
 */

import { z } from "zod";

/** The attribute a raised hand rides in. Empty is how a browser takes something
 *  back: attributes are a bag of strings with no way to remove a key. */
export const HAND = "hand";

/**
 * What can be sent as a reaction.
 *
 * A closed list rather than an emoji picker, and that is deliberate. A reaction
 * is drawn over somebody's face by every browser in the call, so it is a thing
 * one person makes appear on everybody else's screen - and the shortest way to
 * make that unpleasant is to allow arbitrary characters in it. These six are the
 * ones every call product settles on because they are the ones people use.
 */
export const REACTIONS = ["+1", "-1", "clap", "laugh", "surprise", "heart"] as const;

export type Reaction = (typeof REACTIONS)[number];

/** What each one is drawn as, and what a screen reader is told it was. */
export const REACTION_GLYPHS: Readonly<Record<Reaction, string>> = {
    "+1": "\u{1F44D}",
    "-1": "\u{1F44E}",
    clap: "\u{1F44F}",
    laugh: "\u{1F602}",
    surprise: "\u{1F62E}",
    heart: "\u{2764}\u{FE0F}"
};

export const REACTION_LABELS: Readonly<Record<Reaction, string>> = {
    "+1": "Yes",
    "-1": "No",
    clap: "Applause",
    laugh: "Funny",
    surprise: "Surprised",
    heart: "Love it"
};

/** How long one stays on screen. Long enough to be seen across a grid of faces,
 *  short enough that a room of ten agreeing at once clears again. */
export const REACTION_FOR_MS = 3_000;

/**
 * What one browser sends another that is not about combining.
 *
 * Validated exactly as strictly as a request body: it arrives from somebody
 * else's browser, and the fact that they are in the same call as us makes it no
 * more trustworthy than a form post.
 */
export const callSignalSchema = z.object({
    kind: z.literal("reaction"),
    reaction: z.enum(REACTIONS)
});

export type CallSignal = z.infer<typeof callSignalSchema>;

/** One reaction on screen, keyed so the same person sending two in a row draws
 *  two rather than replacing the first. */
export interface ShownReaction {
    readonly id: string;
    /** The seat it came from, which is the tile it is drawn over. */
    readonly from: string;
    readonly reaction: Reaction;
    readonly at: number;
}

/** Whether an attribute bag says this person has their hand up. */
export function handRaised(attributes: Record<string, string> | undefined): boolean {
    return attributes?.[HAND] === "1";
}

/** The attribute carrying the moment a hand went up, so a queue can be ordered
 *  by every browser from what the server already hands it. */
export const HAND_AT = `${HAND}At`;

/** When a hand went up, or zero for one that is down. */
export function handRaisedAt(attributes: Record<string, string> | undefined): number {
    const at = Number(attributes?.[HAND_AT] ?? 0);
    return Number.isFinite(at) && at > 0 ? at : 0;
}

/** Only what the queue needs of somebody. */
export interface HandFacts {
    readonly id: string;
    readonly hand: boolean;
    readonly handAt: number;
}

/**
 * The people with a hand up, oldest first.
 *
 * Order matters, which is why this is a list and not a set: a hand is a queue,
 * and the point of putting one up in a call of twenty is that whoever is
 * chairing knows who to go to next. Every browser sorts the same list from facts
 * they can all see, so there is nothing to agree on and no message to miss - and
 * a hand raised in the same millisecond as another is broken by the seat id
 * rather than left to sort order, so nobody sees a different queue.
 */
export function handQueue(people: readonly HandFacts[]): string[] {
    return people
        .filter((person) => person.hand)
        .sort((left, right) => left.handAt - right.handAt || left.id.localeCompare(right.id))
        .map((person) => person.id);
}
