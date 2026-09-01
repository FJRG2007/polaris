/**
 * What one person may be told about another, beside a conversation.
 *
 * What is shown is deliberately what an account publishes about itself: what it
 * is called, the handle that tells two people with the same name apart, and
 * whatever they wrote about themselves. An address, a number and the name on the
 * account are not - they are three settings on that person's own privacy screen,
 * all three default to nobody, and being in a conversation with somebody has
 * never been consent to hand any of them over. Anything added here later has to
 * answer that question first.
 *
 * The name behind the display name is the one worth spelling out, because it is
 * the whole reason an account has two: the display name is chosen to be seen and
 * is what every screen draws, and the name on the account is an ordinary
 * personal detail. So it is only ever included for a reader that person allows,
 * and the panel simply has nothing to draw for everybody else.
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

import { prisma, VISIBLE_USER } from "@polaris/db";
import { maySee } from "@/lib/privacy-service";
import { blockedBetween } from "@/lib/blocks";
import { mutualsBetween } from "@/lib/mutuals";
import { channelAccess, type ChatActor } from "./access";

/** Somebody, as a profile panel draws them. */
export interface ChatProfile {
    /** What they are called on screen. */
    readonly name: string;
    /** Their name, both halves, when they have given either AND allow this
     *  reader to see it. Empty otherwise - which is most accounts and every
     *  reader by default, and a panel that would have drawn an empty line. */
    readonly fullName: string;
    /** Empty for an account that has not taken one. */
    readonly username: string;
    /** What they wrote about themselves. Empty when they have written nothing. */
    readonly description: string;
    /** The one line under their name, empty when they have written none. */
    readonly headline: string;
    /** How they want to be referred to. Empty when they have not said, and then
     *  nothing is drawn - it is a person who did not answer, not a blank field. */
    readonly pronouns: string;
    /**
     * The friends and the spaces the two of them share.
     *
     * The same answer the profile page draws and from the same module, because
     * this panel IS that profile drawn in a column. Neither half is a disclosure
     * either side has not already made: a friend in common is somebody both are
     * friends with, and a space in common is a room both are standing in.
     */
    readonly mutual: {
        readonly friends: { people: { id: string; name: string; username: string }[]; total: number };
        readonly spaces: { spaces: { id: string; name: string; color: string }[]; total: number };
    };
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

    const [person, together, blocked, mayReadName] = await Promise.all([
        prisma.user.findFirst({
            where: { id: userId, ...VISIBLE_USER },
            select: {
                id: true,
                name: true,
                firstName: true,
                lastName: true,
                username: true,
                description: true,
                headline: true,
                pronouns: true
            }
        }),
        // Asked the same way about them, rather than by looking for a membership
        // row: a public channel in an "everybody here" space is reached without
        // one, and a rule that only counted rows would refuse the profile of
        // somebody who is plainly in the room.
        channelAccess({ id: userId }, channelId),
        blockedBetween(actor.id, [userId]),
        // Never as an administrator, like everything else in chat: whoever runs
        // the instance can read the database, and that is a different and
        // visible act from a screen Polaris drew for them.
        maySee(userId, "fullName", { id: actor.id, isAdmin: false })
    ]);
    if (!person || !together || blocked.has(person.id)) return null;

    // Asked after the reach above rather than beside it: there is no point
    // working out what two people have in common before it is settled that this
    // one may be shown the other at all.
    const mutual = await mutualsBetween(actor.id, person.id);

    return {
        name: person.name,
        fullName: mayReadName
            ? [person.firstName, person.lastName].filter(Boolean).join(" ").trim()
            : "",
        username: person.username ?? "",
        description: person.description.trim(),
        headline: person.headline?.trim() ?? "",
        pronouns: person.pronouns?.trim() ?? "",
        mutual
    };
}
