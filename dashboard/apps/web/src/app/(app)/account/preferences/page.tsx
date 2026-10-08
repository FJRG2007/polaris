/**
 * Preferences page (/account/preferences): the language this account reads
 * Polaris in, how it wants dates, times, temperatures and money written, and
 * how big Polaris is drawn for them.
 * Anything left on "Platform default" follows what the operator set for the
 * deployment.
 *
 * A couple of the settings here are per browser rather than per account - what
 * is cached on this device, and whether covers are taken off before they are
 * seen. They say so on their own cards: they are statements about the screen
 * somebody is reading on, not about the person.
 *
 * The reference screen for translation (docs/i18n.md): the page's own words come
 * from `getTranslations`, the client cards' from `useTranslations` under the
 * `<Messages>` that hands them the `account` namespace.
 */

import Link from "next/link";
import { requireUser } from "@/lib/session";
import { resolveDisplayPreferences } from "@polaris/core";
import { SpoilersCard } from "@/app/(app)/chat/spoilers-card";
import { DeviceCacheCard } from "@/components/device-cache-card";
import { SeasonalCard } from "@/components/seasonal/seasonal-card";
import { getSeasonalChoice, seasonsAllowed } from "@/lib/seasonal-service";
import { AccessibilityForm } from "@/components/accessibility-form";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { LanguageCard } from "./language-card";
import { getLocale, getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { saveDisplayPreferencesAction, saveTextSizeAction, setLocaleAction } from "./actions";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";
import {
    getPlatformDisplayPreferences,
    getUserDisplayPreferences,
    usersMayChooseTheme
} from "@/lib/display-prefs-service";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
    const session = await requireUser();
    const [platform, mine, mayChooseTheme, locale, t, seasonsOn, seasonal] = await Promise.all([
        getPlatformDisplayPreferences(),
        getUserDisplayPreferences(session.id),
        usersMayChooseTheme(),
        getLocale(),
        getTranslations("account"),
        seasonsAllowed(),
        getSeasonalChoice(session.id)
    ]);

    const effective = resolveDisplayPreferences(platform, mine, locale);
    // What a field left on "Platform default" resolves to for this reader: the
    // operator's choice, or what their language implies where there is none.
    const fallback = resolveDisplayPreferences(platform, undefined, locale);

    return (
        <Messages namespaces={["account"]}>
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {t("preferences.title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">{t("preferences.intro")}</p>
                </div>
                <LanguageCard current={locale} save={setLocaleAction} />
                <DisplayPreferencesForm
                    // The size lives in its own form below and is saved on its own,
                    // so it is kept out of the blob this one replaces.
                    initial={{ ...mine, textSize: undefined }}
                    fallback={fallback}
                    allowInherit
                    allowTheme={mayChooseTheme}
                    save={saveDisplayPreferencesAction}
                />
                <AccessibilityForm
                    initial={effective.textSize}
                    // What this deployment treats as normal, so somebody who has
                    // moved the slider can find their way back to it.
                    standard={fallback.textSize}
                    save={saveTextSizeAction}
                />
                <SeasonalCard allowed={seasonsOn} initial={seasonal} />
                <SpoilersCard />
                <DeviceCacheCard />
                {/* The install offer used to be on this page, because this is where the
                    browser's own install prompt was already being held. It has moved to
                    one screen with everything else installable, and this points at it
                    rather than drawing a second copy. */}
                <Card>
                    <CardHeader>
                        <CardTitle>{t("apps.title")}</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col items-start gap-3">
                        <p className="text-sm text-muted-foreground">{t("apps.body")}</p>
                        <Button asChild size="sm" variant="secondary">
                            <Link href="/account/downloads">{t("apps.downloads")}</Link>
                        </Button>
                    </CardBody>
                </Card>
            </div>
        </Messages>
    );
}
