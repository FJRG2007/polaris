/**
 * Display defaults admin (/admin/display): the units and formats new accounts
 * start from and every account that has not chosen its own keeps following.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { resolveDisplayPreferences } from "@polaris/core";
import { savePlatformDisplayAction } from "./actions";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";
import { getPlatformDisplayPreferences } from "@/lib/display-prefs-service";

export const dynamic = "force-dynamic";

export default async function DisplayAdminPage() {
    await requireAdmin();
    const platform = await getPlatformDisplayPreferences();

    return (
        <>
            <PageHeader
                title="Display defaults"
                description="Units and formats for the whole deployment. Each account can override them under Account > Preferences."
            />
            <div className="max-w-2xl">
                <DisplayPreferencesForm
                    initial={resolveDisplayPreferences(platform)}
                    fallback={resolveDisplayPreferences(platform)}
                    allowInherit={false}
                    save={savePlatformDisplayAction}
                />
            </div>
        </>
    );
}
