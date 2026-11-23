/**
 * Who opened a public link, when they happened to be signed in to Polaris.
 *
 * A share or snippet link needs no session - the token is the credential - but a
 * visitor who is signed in carries one anyway, and the owner reading the link's
 * access log wants to know it was a colleague rather than an address. The answer
 * comes from the visitor's own session cookie, resolved on the server the way
 * every background route resolves it; nothing the request says about itself is
 * believed.
 *
 * A session the account controls would refuse - locked, still waiting for
 * approval, banned - names nobody, so the row stays anonymous. An administrator
 * looking at Polaris as somebody else is recorded as themselves: the log is
 * about who was at the keyboard.
 */

/**
 * The account behind this request, or null when it carries no usable session.
 * Never throws: an unreadable cookie or a request with no scope at all is an
 * anonymous visit, not a failure of the page that is recording it.
 *
 * The session module is loaded here, on first use, rather than at the top: the
 * share and snippet services that log through this are also imported where no
 * request is being served (their unit tests among them), and a static import
 * would make each of those load the whole authentication stack, and demand its
 * environment, just to use an unrelated helper.
 */
export async function linkVisitorId(): Promise<string | null> {
    try {
        const { backgroundUser } = await import("@/lib/session");
        const user = await backgroundUser();
        if (!user) return null;
        return user.viewingAs?.actorId ?? user.id;
    } catch {
        return null;
    }
}

/** The account columns an access log reads for its "Who" column. Never the
 *  address: a log that does not read it cannot print it. */
export const linkVisitorSelect = {
    id: true,
    name: true,
    username: true
} as const;

/** A signed-in visitor, as the owner of the link is shown them. */
export interface LinkVisitor {
    id: string;
    name: string;
    username: string | null;
}

/** Signed-in visitors by account id, shaped as `toLinkVisitor`. */
export async function linkVisitorsByIds(ids: readonly string[]): Promise<Map<string, LinkVisitor>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const { prisma } = await import("@polaris/db");
    const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: linkVisitorSelect });
    const found = new Map<string, LinkVisitor>();
    for (const user of users) {
        const visitor = toLinkVisitor(user);
        if (visitor) found.set(user.id, visitor);
    }
    return found;
}

/**
 * Shape an account for the owner's access log: the name it goes by and the
 * handle that opens its profile - never the email address, even for an account
 * with neither, since the owner is told who it was, not handed contact details
 * nobody offered them.
 */
export function toLinkVisitor(
    user: { id: string; name: string; username: string | null } | null
): LinkVisitor | null {
    if (!user) return null;
    // Never the address: whoever reads a visitor log is not owed it.
    const name = user.name.trim() || user.username?.trim() || "Somebody";
    return { id: user.id, name, username: user.username?.trim() || null };
}
