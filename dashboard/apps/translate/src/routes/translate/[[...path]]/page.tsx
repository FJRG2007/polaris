/**
 * Translate at `/translate`, for anybody signed in. The server hands over the
 * frame and whether the reader may change the app's settings; the screen asks
 * for the engines and the history in the browser, so the panes are on screen
 * before any request has left.
 *
 * `/translate/glossaries` is the reader's own glossaries and never-translate
 * list, for anybody who may translate.
 *
 * `/translate/settings` is the app's administrator settings, drawn only by
 * Management > Polaris apps > Translate > Settings
 * (`/admin/apps/translate/settings`); at its own address it is not found.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { host } from "@polaris/app-host";
import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { translateT } from "../../../lib/i18n";
import { SettingsPanel } from "../../../screens/settings-panel";
import { GlossaryManager } from "../../../screens/glossary-manager";
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
    if (!Array.isArray(raw) || raw.length !== 1) notFound();
    const glossaries = raw[0] === "glossaries";
    if (!glossaries && (raw[0] !== "settings" || !user.isAdmin)) notFound();
    const t = await translateT();
    // Drawn inside the admin settings page, which draws the frame around it.
    if (!glossaries)
        return (
            <div className="flex min-w-0 flex-col gap-4">
                <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
                <SettingsPanel />
            </div>
        );
    return (
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
            <Link
                href="/translate"
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                {t("title")}
            </Link>
            <PageHeader title={t("glossary.title")} description={t("glossary.description")} />
            <GlossaryManager />
        </div>
    );
}
