/**
 * Connecting a Stream Deck (/account/streamdeck).
 *
 * The plugin's settings screen opens this page with its code in the address, or
 * shows the code for somebody to type here. The same approval the CLI's sign-in
 * uses, in a deck's words, finding only a deck's requests.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { CliApproveView } from "../cli/cli-approve-view";

export const dynamic = "force-dynamic";

export default async function StreamDeckPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("streamdeck.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("streamdeck.page.intro")}</p>
            </div>
            <CliApproveView
                kind="streamdeck"
                account={t("cli.signedInAs", { name: user.name || user.email })}
            />
        </div>
    );
}
