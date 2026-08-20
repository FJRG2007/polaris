/**
 * What one person may be told about another, beside a conversation.
 *
 * What is shown is deliberately what an account publishes about itself: what it
 * is called, the name behind that, the handle that tells two people with the
 * same name apart, and whatever they wrote about themselves. An address and a
 * number are not - they are two settings on that person's own privacy screen,
 * they default to nobody, and being in a conversation with somebody has never
 * been consent to hand either over. Anything added here later has to answer that
 * question first.
 *
 * Reach is proved by the conversation, and that is the correction worth stating.
 * It used to be proved by the discoverable setting, which is a different
 * question: discoverable is who may FIND you when they go looking, and somebody
 * who is already in a direct message with you has not looked you up - they are
 * talking to you. An account set to "friends" therefore appeared beside its own
 * conversation with no handle and nothing written about it, which read as a
 * profile that had failed to load rather than as a setting doing its job.
 *
 * So the id is not resolved on its own. It is resolved inside a conversation
 * both of them are in, which is what stops this being a directory of everybody
 * on the instance - the thing the discoverable check was standing in for.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { blockedBetween } from "@/lib/blocks";
import { channelAccess, type ChatActor } from "./access";

/** Somebody, as a profile panel draws them. */
export interface ChatProfile {
    /** What they are called on screen. */
    readonly name: string;
    /** Their name, both halves, when they have given either. Empty otherwise -
     *  most accounts, and a panel that would have drawn an empty line. */
    readonly fullName: string;
    /** Empty for an account that has not taken one. */
    readonly username: string;
    /** What they wrote about themselves. Empty when they have written nothing. */
    readonly description: string;
}

/**
 * One person's profile, or null when this reader may not be shown it.
 *
 * Null covers the reader not being in that conversation, the other person not
 * being in it either, the account being gone, and a block in either direction -
 * one answer, because telling them apart would tell somebody which of them it
 * was.
 */
export async function chatProfile(
    actor: ChatActor,
    channelId: string,
    userId: string
): Promise<ChatProfile | null> {
    if (userId === actor.id) return null;

    // The reader's own reach first: everything below describes somebody in a
    // conversation, and whether this is a conversation of theirs is the question
    // that has to be settled before any of it is read.
    const access = await channelAccess(actor, channelId);
    if (!access) return null;

    const [person, together, blocked] = await Promise.all([
        prisma.user.findFirst({
            where: { id: userId, bannedAt: null },
            select: { id: true, name: true, firstName: true, lastName: true, username: true, description: true }
        }),
        // Asked the same way about them, rather than by looking for a membership
        // row: a public channel in an "everybody here" space is reached without
        // one, and a rule that only counted rows would refuse the profile of
        // somebody who is plainly in the room.
        channelAccess({ id: userId }, channelId),
        blockedBetween(actor.id, [userId])
    ]);
    if (!person || !together || blocked.has(person.id)) return null;

    return {
        name: person.name,
        fullName: [person.firstName, person.lastName].filter(Boolean).join(" ").trim(),
        username: person.username ?? "",
        description: person.description.trim()
    };
}
