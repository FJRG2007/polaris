/**
 * Connected accounts (/account/connections): the outside accounts this person has
 * linked, one card per service.
 *
 * It is a personal screen and not part of Integrations on purpose. What an
 * operator connects there is the application; what somebody links here is
 * themselves, and the repositories or calendar that come with it are theirs
 * alone.
 */

import { requireUser } from "@/lib/session";
import { ConnectionsView } from "./connections-view";
import { CONNECTION_PROVIDERS } from "@polaris/core";
import { connectionLinkAvailable } from "@/lib/connections/oauth";
import { connectionLimit, connectionSignInAllowed, listConnections } from "@/lib/connections/store";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
    const user = await requireUser();
    const linked = await listConnections(user.id);

    const providers = await Promise.all(
        CONNECTION_PROVIDERS.map(async (provider) => ({
            slug: provider.slug,
            name: provider.name,
            summary: provider.summary,
            description: provider.description,
            acceptsToken: provider.acceptsToken,
            tokenLabel: provider.tokenLabel,
            tokenHelp: provider.tokenHelp,
            tokenUrl: provider.tokenUrl,
            requires: provider.requires,
            limit: await connectionLimit(provider.slug),
            // Whether the operator has connected the application this authorizes
            // against, and whether it has been shown to work. Without either there
            // is no screen worth sending anybody to, so the card says what to ask
            // for instead of offering a button that fails. An administrator is
            // offered it anyway: theirs is the authorization that proves it.
            canAuthorize: await connectionLinkAvailable(provider.slug, { admin: user.isAdmin }),
            // Whether the operator allows this service as a way in. Without it,
            // the card says nothing about signing in rather than pointing at a
            // switch that would do nothing.
            canSignIn: await connectionSignInAllowed(provider.slug),
            accounts: linked
                .filter((account) => account.provider === provider.slug)
                .map((account) => ({ ...account, signsIn: account.signInEnabled }))
        }))
    );

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Connected accounts</h1>
                <p className="text-sm text-muted-foreground">
                    The outside accounts Polaris acts with on your behalf. Only yours, and only what you link.
                </p>
            </div>
            <ConnectionsView providers={providers} />
        </div>
    );
}
