/**
 * What one person may be told about another, beside a conversation.
 *
 * Three fields, and the reason there are only three is the rule rather than the
 * scope: a name, a handle and whatever they wrote about themselves are things an
 * account publishes about itself. An address and a number are not - they are two
 * settings on that person's own privacy screen, they default to nobody, and
 * being in a conversation with somebody has never been consent to hand either
 * over. Anything added here later has to answer that question first.
 *
 * Reach is checked rather than assumed. The panel that asks is drawn in a direct
 * message, so the two are obviously in touch - but the id arrives from a browser
 * and an action that resolved any id into a name would be a directory of
 * everybody on the instance, which is exactly what the discoverable setting
 * exists to refuse.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { ChatActor } from "./access";
import { blockedBetween } from "@/lib/blocks";
import { discoverableBy } from "@/lib/privacy-service";

/** Somebody, as a profile panel draws them. */
export interface ChatProfile {
    readonly name: string;
    /** Empty for an account that has not taken one. */
    readonly username: string;
    /** What they wrote about themselves. Empty when they have written nothing. */
    readonly description: string;
}

/**
 * One person's profile, or null when this reader may not be shown it.
 *
 * Null covers the account being gone, the account having hidden itself from
 * this reader, and a block in either direction - one answer, because telling
 * them apart would tell somebody which of the three it was.
 */
export async function chatProfile(actor: ChatActor, userId: string): Promise<ChatProfile | null> {
    if (userId === actor.id) return null;

    const person = await prisma.user.findFirst({
        where: { id: userId, bannedAt: null },
        select: { id: true, name: true, username: true, description: true }
    });
    if (!person) return null;

    const [visible, blocked] = await Promise.all([
        discoverableBy({ id: actor.id, isAdmin: false }, [person.id]),
        blockedBetween(actor.id, [person.id])
    ]);
    if (!visible.has(person.id) || blocked.has(person.id)) return null;

    return {
        name: person.name,
        username: person.username ?? "",
        description: person.description.trim()
    };
}
