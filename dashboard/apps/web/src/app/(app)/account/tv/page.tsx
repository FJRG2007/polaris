/**
 * Connecting Polaris TV (/account/tv).
 *
 * The TV shows a code to scan or to type here. The same approval the CLI's
 * sign-in uses, in a TV's words, finding only a TV's requests.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { CliApproveView } from "../cli/cli-approve-view";

export const dynamic = "force-dynamic";

export default async function TvPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("tv.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("tv.page.intro")}</p>
            </div>
            <CliApproveView
                kind="tv"
                account={t("cli.signedInAs", { name: user.name || user.email })}
            />
        </div>
    );
}
