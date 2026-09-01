/**
 * Telling somebody the account they already have would make this one safer.
 *
 * An address at gmail.com belongs to a Google account by definition. Linking it
 * proves the address without a verification mail, gives its owner a way back in
 * that is not a password, and makes the account harder to take over - all of
 * which is worth saying once and not worth requiring, so this is a notification
 * and never a gate.
 *
 * Raised only where there is something to press. If the operator has not
 * connected the application the link authorizes against, the card on the
 * connections screen says to go and ask them - which is not what somebody who
 * has just made an account should be handed. Nothing is said then.
 */

import { notify } from "@/lib/notifications/dispatch";
import { connectionLinkAvailable } from "@/lib/connections/oauth";
import { findConnectionProvider, providerForMailbox } from "@polaris/core";

/**
 * Suggest linking the service that runs this address, if there is one and it is
 * usable here.
 *
 * Never throws at its caller: this runs off the back of an account being
 * created, and an account must not fail to exist because a suggestion could not
 * be raised.
 */
export async function suggestConnectionLink(userId: string, email: string): Promise<void> {
    try {
        const slug = providerForMailbox(email);
        if (!slug) return;
        const provider = findConnectionProvider(slug);
        if (!provider) return;
        // Not as an administrator: the question is whether this works for the
        // person who just signed up, and an admin-only "you could set it up" is
        // a different sentence to a different reader.
        if (!(await connectionLinkAvailable(slug, { admin: false }))) return;

        await notify({
            userId,
            event: "account.link.suggested",
            title: `Link your ${provider.name} account`,
            body: `You signed up with a ${provider.name} address. Linking it confirms the address, and lets you sign in without a password.`,
            href: "/account/connections"
        });
    } catch {
        // A suggestion nobody got is not worth failing a sign-up over.
    }
}
