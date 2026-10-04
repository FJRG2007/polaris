/**
 * Signing in the command-line client (/account/cli).
 *
 * `plr login` opens this page with its code in the address, or shows the code
 * for somebody to type here from another device. Nothing it holds works until
 * somebody signed in says yes.
 */

import { requireUser } from "@/lib/session";
import { CliApproveView } from "./cli-approve-view";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function CliPage() {
    await requireUser();
    const t = await getTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("cli.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("cli.page.intro")}</p>
            </div>
            <CliApproveView />
        </div>
    );
}
