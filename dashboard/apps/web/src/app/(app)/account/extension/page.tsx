/**
 * Connecting the browser extension (/account/extension).
 *
 * The extension's first step, and the only one that needs a person: it shows a
 * short code, opens this page on the Polaris it was pointed at, and somebody who
 * is already signed in says yes. Nothing it holds works until then.
 *
 * On the account rather than in the vault, because that is what the connection
 * is about. A vault is something the extension may be used for afterwards, and
 * letting it into one is still the vault's own screen and its own approval.
 */

import { getTranslations } from "@/lib/i18n/request";
import { requireUser } from "@/lib/session";
import { ExtensionConnectView } from "./extension-connect-view";

export const dynamic = "force-dynamic";

export default async function ExtensionPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("extension.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("extension.page.intro")}</p>
            </div>
            <ExtensionConnectView
                account={t("extension.signedInAs", { name: user.name || user.email })}
            />
        </div>
    );
}
