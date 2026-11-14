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
import { Messages } from "@/components/i18n/messages";
import { VpnDeviceKeys } from "@/components/vpn/device-keys";
import { isClientKey } from "@/lib/vault/client-key";
import { vpnMeshOn } from "@/lib/vpn/mesh";
import { isDeviceSessionKind } from "@/lib/device-sessions/kinds";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    // Only the keys. What a key may carry is decided on the page that mints or
    // changes one, which is where the scopes and the address groups are read.
    // Not the ones a connected app was given. They are issued by approving a
    // client rather than by anybody filling in this screen's form, and a row here
    // that appeared on its own is a credential nobody can explain later - which is
    // the kind people leave alone rather than manage. Assistants connected over
    // MCP have their own screen, Account > AI assistants. Nor what a device's
    // app signed in with (the command line, a Stream Deck, a TV, the browser
    // extension): those are sessions, listed and signed out under Account >
    // Sessions.
    // VPN device keys belong to the VPN's device network, an integration that is
    // off unless an administrator switched it on.
    const [all, mesh] = await Promise.all([
        listApiKeys(user.id),
        vpnMeshOn().catch(() => false)
    ]);
    const keys = all.filter(
        (key) => !isClientKey(key.description) && !isDeviceSessionKind(key.kind)
    );

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
            {mesh ? (
                <Messages namespaces={["vpn"]}>
                    <VpnDeviceKeys />
                </Messages>
            ) : null}
        </div>
    );
}
