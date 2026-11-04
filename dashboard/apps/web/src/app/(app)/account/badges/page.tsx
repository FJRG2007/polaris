/**
 * Badges (/account/badges): which ones the profile shows, in what order, and to
 * whom. Only the header is drawn here; the badges load after the first paint.
 */

import { requireUser } from "@/lib/session";
import { BadgesSettings } from "./badges-settings";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function BadgesPage() {
    const [, t] = await Promise.all([requireUser(), getTranslations("badges")]);
    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("settings.intro")}</p>
            </div>
            <BadgesSettings />
        </div>
    );
}
