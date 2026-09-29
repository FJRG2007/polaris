/**
 * Display defaults admin (/admin/display): the units and formats new accounts
 * start from and every account that has not chosen its own keeps following.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { savePlatformDisplayAction } from "./actions";
import { resolveDisplayPreferences } from "@polaris/core";
import { ThemePolicyCard } from "./theme-policy";
import { getTranslations } from "@/lib/i18n/request";
import { getPlatformDisplayPreferences, usersMayChooseTheme } from "@/lib/display-prefs-service";
import { Messages } from "@/components/i18n/messages";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";

export const dynamic = "force-dynamic";

export default async function DisplayAdminPage() {
    await requireAdmin();
    const [platform, mayChooseTheme, t] = await Promise.all([
        getPlatformDisplayPreferences(),
        usersMayChooseTheme(),
        getTranslations("admin")
    ]);

    return (
        // Narrow page: centre the column in the content area, header included, so
        // the form does not sit against the rail with the width beside it empty.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title={t("display.title")}
                description={t("display.description")}
            />
            {/* The form is the account page's too, and its words are there. */}
            <Messages namespaces={["account"]}>
                <DisplayPreferencesForm
                    initial={resolveDisplayPreferences(platform)}
                    fallback={resolveDisplayPreferences(platform)}
                    allowInherit={false}
                    save={savePlatformDisplayAction}
                />
            </Messages>
            <ThemePolicyCard allowed={mayChooseTheme} />
        </div>
    );
}
