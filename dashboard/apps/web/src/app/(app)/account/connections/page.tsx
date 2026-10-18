/**
 * Connected accounts (/account/connections): the outside accounts this person has
 * linked, one card per service.
 *
 * It is a personal screen and not part of Integrations on purpose. What an
 * operator connects there is the application; what somebody links here is
 * themselves, and the repositories or calendar that come with it are theirs
 * alone.
 */

import { getTranslations } from "@/lib/i18n/request";
import { requireUser, sessionCan } from "@/lib/session";
import { ConnectionsView } from "./connections-view";
import { CONNECTION_PROVIDERS } from "@polaris/core";
import { connectionLimit, connectionSignInAllowed, listConnections } from "@/lib/connections/store";
import { lastfmApiKey } from "@/lib/presence-activity/lastfm-poll";
import { connectionFailure } from "@/lib/connections/attention";
import {
    connectionLinkAvailable,
    linkScopesSatisfied,
    missingLinkScopes
} from "@/lib/connections/oauth";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage({
    searchParams
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    // Only what the screen reads on its first render: which service an app sent
    // somebody here for, and the app to offer the way back to.
    const params = (await searchParams) ?? {};
    const initial = new URLSearchParams();
    for (const key of ["provider", "return"]) {
        const value = params[key];
        if (typeof value === "string") initial.set(key, value);
    }
    const user = await requireUser();
    const t = await getTranslations("account");
    const [linked, lastfmReady, canConfigure] = await Promise.all([
        listConnections(user.id),
        lastfmApiKey().then((key) => key !== null),
        sessionCan(user, "settings.manage")
    ]);

    const providers = await Promise.all(
        CONNECTION_PROVIDERS.map(async (provider) => ({
            slug: provider.slug,
            name: provider.name,
            category: provider.category,
            summary: provider.summary,
            description: provider.description,
            acceptsToken: provider.acceptsToken,
            tokenLabel: provider.tokenLabel,
            tokenHelp: provider.tokenHelp,
            tokenUrl: provider.tokenUrl,
            // Offered whether or not the operator has connected the application
            // behind the verified link: typing a name needs nothing from them.
            // Except Last.fm, whose name is only worth typing once the operator
            // has added the key it is read with; until then the card says so.
            acceptsTypedName:
                (provider.acceptsTypedName ?? false) && (provider.slug !== "lastfm" || lastfmReady),
            typedOnly: provider.typedOnly ?? false,
            requires: provider.requires,
            limit: await connectionLimit(provider.slug),
            // Whether the operator has connected the application this authorizes
            // against, and whether it has been shown to work. Without either there
            // is no screen worth sending anybody to, so the card says what to ask
            // for instead of offering a button that fails. An administrator is
            // offered it anyway: theirs is the authorization that proves it.
            canAuthorize: await connectionLinkAvailable(provider.slug, {
                admin: user.isAdmin,
                userId: user.id
            }),
            // Whether the operator allows this service as a way in. Without it,
            // the card says nothing about signing in rather than pointing at a
            // switch that would do nothing.
            canSignIn: await connectionSignInAllowed(provider.slug),
            // Only whoever configures integrations can act on why the provider
            // refused, and only they are shown it; everybody else is told the
            // administrators know.
            ...(canConfigure
                ? { lastFailure: (await connectionFailure(provider.slug))?.reason }
                : {}),
            accounts: linked
                .filter((account) => account.provider === provider.slug)
                .map((account) => ({
                    ...account,
                    signsIn: account.signInEnabled,
                    // Measured against what is asked for now, not against what was
                    // asked for the day this was linked. A consent screen that has
                    // grown since leaves working links that cannot do the new
                    // thing, and only their owner can approve the difference.
                    needsReauthorization: !linkScopesSatisfied(account.provider, account.scope),
                    missingScopes: missingLinkScopes(account.provider, account.scope)
                }))
        }))
    );

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("connections.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("connections.page.intro")}</p>
            </div>
            <ConnectionsView providers={providers} initialSearch={initial.toString()} />
        </div>
    );
}
