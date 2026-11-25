"use client";

/**
 * Sealed votes on the poll card (docs/chat-e2ee-mls.md, "Sealed votes"): a
 * vote on a poll in a sealed conversation is sealed in this browser and the
 * tally is made here from the ballots this browser opens, so the server never
 * learns who picked which answer. Never voted in the clear instead.
 */

import * as actions from "./actions";
import type { ChatPollView } from "@/lib/chat/polls";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";

/** Pages of ballots read at most for one card: 50,000 voters. */
const MAX_PAGES = 50;

/** One opened ballot: what it picks (null when it did not open here). */
export interface OpenedBallot {
    readonly picks: readonly number[] | null;
    readonly mine: boolean;
    readonly voter?: { readonly id: string; readonly name: string };
}

/**
 * Whether a ballot's picks are a vote this poll can take: at least one
 * answer, every one an answer it has, and only one on a poll that takes one.
 * The server cannot check this - it cannot read the ballot - so every
 * browser discards the same ballots.
 */
export function validPicks(poll: ChatPollView, picks: readonly number[] | null): picks is readonly number[] {
    if (!picks || picks.length === 0) return false;
    if (!poll.multiple && picks.length > 1) return false;
    return picks.every((at) => at >= 0 && at < poll.options.length);
}

/**
 * `poll` with the opened ballots counted in: the server's counts hold only
 * the votes cast in the clear before, and this reader's own ballot says which
 * answers are theirs. A poll whose results are hidden gets no counts, only
 * this reader's marks.
 */
export function withBallots(poll: ChatPollView, ballots: readonly OpenedBallot[]): ChatPollView {
    const counts = poll.options.map(() => 0);
    let own: readonly number[] | null = null;
    for (const ballot of ballots) {
        if (!validPicks(poll, ballot.picks)) continue;
        if (ballot.mine) own = ballot.picks;
        for (const at of ballot.picks) counts[at] = (counts[at] ?? 0) + 1;
    }
    const mine = own ? new Set(own) : null;
    return {
        ...poll,
        options: poll.options.map((option, at) => ({
            ...option,
            votes: poll.results ? option.votes + (counts[at] ?? 0) : option.votes,
            mine: mine ? mine.has(at) : option.mine
        }))
    };
}

/** Who picked each answer, by answer id, from the opened ballots of a public poll. */
export function votersByAnswer(poll: ChatPollView, ballots: readonly OpenedBallot[]): Map<string, { id: string; name: string }[]> {
    const out = new Map<string, { id: string; name: string }[]>();
    for (const ballot of ballots) {
        if (!ballot.voter || !validPicks(poll, ballot.picks)) continue;
        for (const at of ballot.picks) {
            const id = poll.options[at]!.id;
            out.set(id, [...(out.get(id) ?? []), { id: ballot.voter.id, name: ballot.voter.name }]);
        }
    }
    return out;
}

/** Read and open every ballot of a sealed poll this reader may see. */
export async function loadBallots(channelId: string, messageId: string, poll: ChatPollView): Promise<OpenedBallot[]> {
    const out: OpenedBallot[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await actions.pollBallotsAction({ messageId, after });
        if (!result.page) throw new Error(result.error ?? "the ballots did not load");
        const picks = await sealedChat.openBallots(channelId, messageId, poll.anonymous, result.page.ballots);
        result.page.ballots.forEach((row, at) => out.push({ picks: picks[at] ?? null, mine: row.mine, ...(row.voter ? { voter: row.voter } : {}) }));
        after = result.page.next;
        if (!after) break;
    }
    return out;
}

/** Seal and cast this reader's vote (the answer ids they stand behind now; none takes it back). */
export async function castSealedVote(channelId: string, messageId: string, poll: ChatPollView, optionIds: readonly string[]): Promise<{ error?: string }> {
    const picks = optionIds.map((id) => poll.options.findIndex((option) => option.id === id)).filter((at) => at >= 0);
    const ballot = picks.length ? await sealedChat.sealBallot(channelId, messageId, poll.anonymous, picks) : null;
    return actions.castBallotAction({ messageId, ballot });
}
