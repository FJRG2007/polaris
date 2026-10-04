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

/** The account columns an access log reads for its "Who" column. Email is not
 *  among them unless the account has nothing else to be called by. */
export const linkVisitorSelect = {
    id: true,
    name: true,
    username: true,
    email: true
} as const;

/** A signed-in visitor, as the owner of the link is shown them. */
export interface LinkVisitor {
    id: string;
    name: string;
    username: string | null;
}

/**
 * Shape an account for the owner's access log: the name it goes by, the handle
 * that opens its profile, and the email address only when there is neither -
 * the owner is told who it was, not handed contact details nobody offered them.
 */
export function toLinkVisitor(
    user: { id: string; name: string; username: string | null; email: string } | null
): LinkVisitor | null {
    if (!user) return null;
    const name = user.name.trim() || user.username?.trim() || user.email;
    return { id: user.id, name, username: user.username?.trim() || null };
}
