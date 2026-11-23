/**
 * Device add-ons (/account/addons): the store of add-ons for hardware plugged
 * into this computer, installed by the desktop app on this device only.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { AddonsStore } from "./addons-view";

export default async function AddonsPage() {
    await requireUser();
    const t = await getTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div className="min-w-0">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("addons.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("addons.page.intro")}</p>
            </div>
            <AddonsStore />
        </div>
    );
}
