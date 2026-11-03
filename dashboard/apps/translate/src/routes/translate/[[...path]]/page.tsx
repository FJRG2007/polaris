/**
 * Translate at `/translate`, for anybody signed in. The server hands over the
 * frame and whether the reader may change the app's settings; the screen asks
 * for the engines and the history in the browser, so the panes are on screen
 * before any request has left.
 *
 * `/translate/settings` is the app's administrator settings - the page
 * Management > Polaris apps > Translate > Settings opens - and is there only
 * for an administrator.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { host } from "@polaris/app-host";
import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { translateT } from "../../../lib/i18n";
import { SettingsPanel } from "../../../screens/settings-panel";
import { TranslateScreen } from "../../../screens/translate-screen";

export const dynamic = "force-dynamic";

export default async function TranslatePage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const [user, raw] = await Promise.all([
        host.session.requirePermission("translate.use"),
        params.then((all) => all.path)
    ]);
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0))
        return <TranslateScreen manager={user.isAdmin} />;
    if (!Array.isArray(raw) || raw.length !== 1 || raw[0] !== "settings" || !user.isAdmin)
        notFound();
    const t = await translateT();
    return (
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
            <Link
                href="/admin/apps/translate"
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                {t("title")}
            </Link>
            <PageHeader title={t("settings.title")} description={t("settings.description")} />
            <SettingsPanel />
        </div>
    );
}
