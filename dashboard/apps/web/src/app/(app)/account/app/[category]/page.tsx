/**
 * Settings > This app (/account/app/<category>): the desktop or phone app's
 * own settings, one screen per category.
 *
 * Nothing is read on the server: the values live on the computer, and the page
 * reads and writes them through the app's bridge (`AppSettingsView`). Outside
 * the app the same address says where these settings are changed. The loading
 * state draws the same screen (`loading.tsx`), so opening a category never
 * waits on the host's answer for the route.
 */

import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { AppSettingsScreen } from "./app-settings-view";
import { readAppSettingCategory } from "@polaris/core/app-settings";

export const dynamic = "force-dynamic";

export default async function AppSettingsPage({ params }: { params: Promise<{ category: string }> }) {
    await requireUser();
    const category = readAppSettingCategory((await params).category);
    if (!category) notFound();
    return <AppSettingsScreen category={category} />;
}
