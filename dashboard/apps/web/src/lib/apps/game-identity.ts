/**
 * Turning somebody's Polaris account into the id a game server is closed by.
 *
 * A game server does not know what a Polaris user is. ARK's door takes a
 * seventeen-digit Steam id and nothing else, so letting a friend in meant asking
 * them for that number, over a chat app, and pasting it correctly - which is the
 * step people get wrong and the reason a server sits open to everyone instead.
 *
 * Whoever has linked their Steam account here has already handed that number over
 * in a way that cannot be mistyped, so this is the whole of it: a name or an
 * address goes in, and the id that account proved comes out.
 *
 * Deliberately narrow. It answers about accounts somebody linked themselves, it
 * never invents an id for an account that has not been linked, and it says which
 * service the id belongs to - an Epic id and a Steam id are not interchangeable
 * on a server that only speaks one of them.
 */

import { prisma } from "@polaris/db";

/** The services a game identity can come from. Steam today; the same shape holds
 *  an Epic id the day that link exists. */
export type GameIdentityProvider = "steam";

export interface GameIdentity {
    /** The Polaris account it belongs to. */
    readonly userId: string;
    /** What Polaris calls them, for the row that is about to be written. */
    readonly name: string;
    readonly provider: GameIdentityProvider;
    /** The provider's own id - a SteamID64 for Steam. */
    readonly accountId: string;
    /** What the provider calls the account, when it said. Falls back to the id. */
    readonly label: string;
}

/**
 * Who this is, by username or email address, and the game account they linked.
 *
 * Null when nobody matches, and `identity: null` when somebody does but has
 * linked nothing - two different answers, because the screen says two different
 * things: "no such person here" against "ask them to link their Steam account".
 */
export async function findGameIdentity(
    query: string,
    provider: GameIdentityProvider
): Promise<{ userId: string; name: string; identity: GameIdentity | null } | null> {
    // Trimmed and lowercased, which is how both columns are stored - the same
    // normalization sharing a server with somebody uses, so the two screens
    // cannot disagree about who a name refers to.
    const identifier = query.trim().toLowerCase();
    if (!identifier) return null;
    const person = await prisma.user.findFirst({
        where: { OR: [{ email: identifier }, { username: identifier }] },
        select: { id: true, name: true, username: true }
    });
    if (!person) return null;

    const name = person.name || person.username || identifier;
    const link = await prisma.userConnection.findFirst({
        where: { userId: person.id, provider },
        select: { accountId: true, label: true },
        // The one they linked most recently, for the rare account with two.
        orderBy: { linkedAt: "desc" }
    });
    return {
        userId: person.id,
        name,
        identity: link
            ? {
                  userId: person.id,
                  name,
                  provider,
                  accountId: link.accountId,
                  label: link.label || link.accountId
              }
            : null
    };
}
