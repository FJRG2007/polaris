/**
 * API keys page (/account/api-keys): the personal access tokens a user issues to
 * themselves so a script can act on their behalf without their password. The
 * scope checkboxes are built from what this user actually holds, so a key can
 * never be created with more reach than its owner.
 */

import { getTranslations } from "@/lib/i18n/request";
import { listApiKeys } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { ApiKeysView } from "./api-keys-view";
import { ConnectedApps } from "./connected-apps";
import { isClientKey } from "@/lib/vault/client-key";
import { Messages } from "@/components/i18n/messages";
import { listConnectedApps } from "@/lib/mcp/oauth/grants";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    // Only the keys. What a key may carry is decided on the page that mints or
    // changes one, which is where the scopes and the address groups are read.
    // Not the ones a connected app was given. They are issued by approving a
    // client rather than by anybody filling in this screen's form, and a row here
    // that appeared on its own is a credential nobody can explain later - which is
    // the kind people leave alone rather than manage. Connected apps are listed,
    // and disconnected, under Account > Sessions.
    const [all, connected] = await Promise.all([listApiKeys(user.id), listConnectedApps(user.id)]);
    const keys = all.filter((key) => !isClientKey(key.description));

    return (
        // Wider than the rest of the account screens, because this one is a
        // table: nine columns squeezed into a reading column is nine columns
        // nobody can compare.
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("apiKeys.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("apiKeys.page.intro")}</p>
            </div>
            <ApiKeysView keys={keys} />
            {/* The assistants that signed in through the consent screen. The
                same kind of credential as a key, made by a different door, so
                they are listed and revoked here too. */}
            <Messages namespaces={["mcp"]}>
                <ConnectedApps apps={connected} />
            </Messages>
        </div>
    );
}
