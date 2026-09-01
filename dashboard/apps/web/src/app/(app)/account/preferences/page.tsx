/**
 * Preferences page (/account/preferences): how this account wants dates, times,
 * temperatures and money written, and how big Polaris is drawn for them.
 * Anything left on "Platform default" follows what the operator set for the
 * deployment.
 */

import { requireUser } from "@/lib/session";
import { saveDisplayPreferencesAction, saveTextSizeAction } from "./actions";
import { resolveDisplayPreferences } from "@polaris/core";
import { AccessibilityForm } from "@/components/accessibility-form";
import { DeviceCacheCard } from "@/components/device-cache-card";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";
import {
    getPlatformDisplayPreferences,
    getUserDisplayPreferences,
    usersMayChooseTheme
} from "@/lib/display-prefs-service";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
    const session = await requireUser();
    const [platform, mine, mayChooseTheme] = await Promise.all([
        getPlatformDisplayPreferences(),
        getUserDisplayPreferences(session.id),
        usersMayChooseTheme()
    ]);

    const effective = resolveDisplayPreferences(platform, mine);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Preferences</h1>
                <p className="text-sm text-muted-foreground">
                    How Polaris looks for your account, and the units and formats it writes in.
                </p>
            </div>
            <DisplayPreferencesForm
                // The size lives in its own form below and is saved on its own,
                // so it is kept out of the blob this one replaces.
                initial={{ ...mine, textSize: undefined }}
                fallback={resolveDisplayPreferences(platform)}
                allowInherit
                allowTheme={mayChooseTheme}
                save={saveDisplayPreferencesAction}
            />
            <AccessibilityForm initial={effective.textSize} save={saveTextSizeAction} />
            <DeviceCacheCard />
        </div>
    );
}
