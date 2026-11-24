/**
 * Settings > This app (/account/app/<category>): the desktop or phone app's
 * own settings, one screen per category.
 *
 * Nothing is read on the server: the values live on the computer, and the page
 * reads and writes them through the app's bridge (`AppSettingsView`). Outside
 * the app the same address says where these settings are changed.
 */

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { AppSettingsIntro, AppSettingsView } from "./app-settings-view";
import { readAppSettingCategory } from "@polaris/core/app-settings";

export const dynamic = "force-dynamic";

export default async function AppSettingsPage({ params }: { params: Promise<{ category: string }> }) {
    await requireUser();
    const category = readAppSettingCategory((await params).category);
    if (!category) notFound();
    const t = await getTranslations("appSettings");

    return (
        <Messages namespaces={["appSettings", "vault"]}>
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {t(`categories.${category}.title`)}
                    </h1>
                    <AppSettingsIntro category={category} />
                </div>
                <AppSettingsView category={category} />
            </div>
        </Messages>
    );
}
