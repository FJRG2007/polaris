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
 * **Lowering somebody else's hand is neither.** It cannot be a state, because a
 * browser may only write its own attributes, and it is not an event about the
 * person sending it - so it is the one thing here that is a request: the chair
 * asks, and the browser holding the hand does the writing. Which makes who asked
 * the whole of the safety, checked where it arrives rather than where it is
 * offered - see `use-sfu-call`.
 *
 * Pure, so all three rules can be checked without a call server.
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
export const callSignalSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("reaction"),
        reaction: z.enum(REACTIONS)
    }),
    /**
     * Put that hand down.
     *
     * The one thing here that is asked of somebody else's browser rather than
     * said about this one, and the reason it can be: a hand rides in an
     * attribute, and a browser may only write its own. So the chair cannot lower
     * anybody's hand directly - they ask, and the browser holding the hand does
     * the writing.
     *
     * Which makes who is asking the whole of the safety, and it is checked on
     * arrival: honoured from the seat the meeting says is its host and dropped
     * from everybody else. Sharing a call with somebody is not permission to
     * reach into their controls, and without that check a call of twenty is
     * twenty people who can each silence a raised hand.
     */
    z.object({ kind: z.literal("lower-hand") })
]);

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

/**
 * Where each raised hand stands, counting from one.
 *
 * The queue was worked out and then never shown, which is most of why raising a
 * hand did not work here: the order existed, the number nobody could see did
 * not, and a hand drawn as a twelve-pixel icon beside five other twelve-pixel
 * icons is a hand nobody notices at all - let alone knows they are third in.
 *
 * A map rather than a search per face: a grid of twenty tiles asking a list of
 * twenty for its own position is four hundred comparisons a render, on the one
 * screen in the product that is already redrawing every time somebody speaks.
 */
export function handPlaces(queue: readonly string[]): ReadonlyMap<string, number> {
    return new Map(queue.map((id, index) => [id, index + 1]));
}

/** One person in the queue, as the strip needs them. */
export interface HandInQueue {
    readonly id: string;
    readonly name: string;
    /** Whether this is the reader's own hand, which is said as "yours" rather
     *  than by name - nobody reads their own name in a list of three and
     *  recognises it faster than the word. */
    readonly own: boolean;
}

/**
 * What the strip says above the faces.
 *
 * One hand is a sentence about a person, because that is what it is: somebody
 * wants to speak and the only thing worth saying is who. Several is a count and
 * then the queue itself, drawn beside this, because at three the question stops
 * being "who" and becomes "who is next".
 */
export function handsSummary(hands: readonly HandInQueue[]): string {
    if (hands.length === 0) return "";
    if (hands.length === 1) {
        const only = hands[0];
        return only?.own ? "Your hand is up" : `${only?.name} has their hand up`;
    }
    return `${hands.length} hands are up`;
}

/**
 * The same, with whoever is next, for a screen that cannot draw the queue.
 *
 * The call bar has room for a count and nothing else, so the order it is hiding
 * has to be said in the sentence behind it. Written here rather than there
 * because it is the same sentence as the strip's plus one clause, and a bar that
 * builds its own is a bar that says "You has a hand up" the first time somebody
 * raises their own and walks to another screen - which is exactly when the bar
 * is the only thing saying anything at all.
 */
export function handsQueueSummary(hands: readonly HandInQueue[]): string {
    const summary = handsSummary(hands);
    if (hands.length < 2) return summary;
    const first = hands[0];
    if (!first) return summary;
    return `${summary}. ${first.own ? "You are first" : `${first.name} is first`}`;
}
