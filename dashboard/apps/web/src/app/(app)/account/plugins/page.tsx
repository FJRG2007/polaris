/**
 * Device plugins (/account/plugins): the store of plugins for hardware plugged
 * into this computer, installed by the desktop app on this device only.
 */

import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { PluginsStore } from "./plugins-view";

export default async function PluginsPage() {
    await requireUser();
    const t = await getTranslations("account");
    return (
        <div className="flex w-full min-w-0 flex-col gap-4">
            <div className="min-w-0">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("plugins.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("plugins.page.intro")}</p>
            </div>
            <PluginsStore />
        </div>
    );
}
