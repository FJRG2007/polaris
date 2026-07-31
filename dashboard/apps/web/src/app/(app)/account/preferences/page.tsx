/**
 * Preferences page (/account/preferences): how this account wants dates, times,
 * temperatures and money written. Anything left on "Platform default" follows
 * what the operator set for the deployment.
 */

import { requireUser } from "@/lib/session";
import { resolveDisplayPreferences } from "@polaris/core";
import { saveDisplayPreferencesAction } from "./actions";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";
import { getPlatformDisplayPreferences, getUserDisplayPreferences } from "@/lib/display-prefs-service";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
    const session = await requireUser();
    const [platform, mine] = await Promise.all([
        getPlatformDisplayPreferences(),
        getUserDisplayPreferences(session.id)
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-lg font-semibold">Preferences</h1>
                <p className="text-sm text-muted-foreground">
                    Units and formats used across Polaris for your account.
                </p>
            </div>
            <DisplayPreferencesForm
                initial={mine}
                fallback={resolveDisplayPreferences(platform)}
                allowInherit
                save={saveDisplayPreferencesAction}
            />
        </div>
    );
}
