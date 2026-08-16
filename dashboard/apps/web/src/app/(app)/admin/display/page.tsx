/**
 * Display defaults admin (/admin/display): the units and formats new accounts
 * start from and every account that has not chosen its own keeps following.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { savePlatformDisplayAction } from "./actions";
import { resolveDisplayPreferences } from "@polaris/core";
import { ThemePolicyCard } from "./theme-policy";
import { getPlatformDisplayPreferences, usersMayChooseTheme } from "@/lib/display-prefs-service";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";

export const dynamic = "force-dynamic";

export default async function DisplayAdminPage() {
    await requireAdmin();
    const [platform, mayChooseTheme] = await Promise.all([
        getPlatformDisplayPreferences(),
        usersMayChooseTheme()
    ]);

    return (
        // Narrow page: centre the column in the content area, header included, so
        // the form does not sit against the rail with the width beside it empty.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Display defaults"
                description="The theme, units and formats for the whole deployment. Each account can override them under Account > Preferences."
            />
            <DisplayPreferencesForm
                initial={resolveDisplayPreferences(platform)}
                fallback={resolveDisplayPreferences(platform)}
                allowInherit={false}
                save={savePlatformDisplayAction}
            />
            <ThemePolicyCard allowed={mayChooseTheme} />
        </div>
    );
}
