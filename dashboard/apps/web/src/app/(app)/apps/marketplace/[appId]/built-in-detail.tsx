"use client";

/**
 * A built-in app's page on the Polaris apps screen, laid out like a phone's app
 * info: who it is, then what an administrator can do with it - open it, change
 * its settings for everybody, and why it cannot be uninstalled - then its build
 * and what it is.
 *
 * The switcher entry is static, so everything but the builds paints with the
 * shell; the builds wait for the update rows, behind their own skeleton, and
 * are asked only when the reader may update apps.
 */

import Link from "next/link";
import { Fact } from "./app-detail";
import { useId, useMemo } from "react";
import { ReplacesRow } from "../replaces-row";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Badge, Button, Skeleton } from "@polaris/ui";
import { useLocalizeStoreApp } from "../use-store-words";
import { ScreenshotGallery } from "./screenshot-gallery";
import { builtInSettingsHref } from "@/lib/apps/app-settings";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { builtInScreenshots } from "@/lib/apps/app-screenshots";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { BuiltInMark, BuiltInPreview, useBuiltInListing } from "../store-card";
import { findBuiltInApp, POLARIS_APPS_PATH } from "@/lib/apps/marketplace-store";
import { buildLabel, useAppUpdates } from "@/components/app-bundles/use-app-updates";
import {
    builtInNativeUpdates,
    NativeUpdateNote,
    switcherCategory,
    UpdateCheckFailed
} from "../marketplace-view";

export function BuiltInAppDetail({
    appId,
    canUpdateApps
}: {
    appId: string;
    /** Whether this reader may update apps, the check the update action makes. */
    canUpdateApps: boolean;
}) {
    const t = useTranslations("marketplace");
    const navLabel = useNavLabel();
    const locale = useLocale();
    const toListing = useBuiltInListing();
    const localize = useLocalizeStoreApp();
    const reason = useId();
    const found = findBuiltInApp(appId);
    const entry = useMemo(() => (found ? toListing(found) : null), [found, toListing]);
    const updates = useAppUpdates({ enabled: canUpdateApps });
    if (!entry) return null;
    const settingsHref = builtInSettingsHref(entry.id);
    const shots = builtInScreenshots(entry.id, locale);
    const natives = canUpdateApps ? builtInNativeUpdates(entry.id, updates, localize) : [];
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <Link
                href={POLARIS_APPS_PATH}
                className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
            >
                <ArrowLeft className="size-4" />
                {t("detail.back")}
            </Link>

            <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
                <BuiltInMark entry={entry} size={72} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 className="break-words text-2xl font-semibold">{entry.name}</h1>
                    <p className="text-muted-foreground break-words text-sm">
                        {t("polaris.builtInBy")}
                    </p>
                    <div>
                        <Badge>{t("polaris.builtIn")}</Badge>
                    </div>
                </div>
            </header>

            <section className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Button asChild>
                        <Link href={entry.href}>{t("card.open")}</Link>
                    </Button>
                    {settingsHref ? (
                        <Button asChild variant="secondary">
                            <Link href={settingsHref}>{t("detail.settings")}</Link>
                        </Button>
                    ) : null}
                    <Button variant="ghost" disabled aria-describedby={reason}>
                        <Trash2 className="size-4" />
                        {t("uninstall.confirm")}
                    </Button>
                </div>
                <p id={reason} className="text-muted-foreground text-xs">
                    {t("polaris.cannotUninstall")}
                </p>
            </section>

            {natives.length > 0 && (
                <section className="flex min-w-0 flex-col gap-2" aria-label={t("detail.builds")}>
                    <h2 className="text-sm font-medium">{t("detail.builds")}</h2>
                    {updates.failed && (
                        <div className="max-w-md">
                            <UpdateCheckFailed updates={updates} />
                        </div>
                    )}
                    {updates.rows !== null || !updates.failed
                        ? natives.map((native) =>
                              native.state.loading ? (
                                  <Skeleton key={native.id} className="h-10 w-full max-w-md" />
                              ) : (
                                  <div
                                      key={native.id}
                                      className="flex min-w-0 max-w-md flex-col gap-1"
                                  >
                                      <dl className="grid min-w-0 grid-cols-1 gap-x-6 text-sm sm:grid-cols-[max-content_1fr]">
                                          <Fact label={native.name}>
                                              {native.state.row?.installed
                                                  ? buildLabel(native.state.row.installed)
                                                  : t("detail.noBuild")}
                                          </Fact>
                                      </dl>
                                      <NativeUpdateNote update={native} />
                                  </div>
                              )
                          )
                        : null}
                </section>
            )}

            {shots.length > 0 ? (
                <ScreenshotGallery name={entry.name} shots={shots} />
            ) : (
                <div className="max-w-2xl overflow-hidden rounded-lg border border-border">
                    <BuiltInPreview entry={entry} shot={null} />
                </div>
            )}

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">{t("detail.about")}</h2>
                <p className="text-muted-foreground whitespace-pre-line break-words text-sm">
                    {entry.summary}
                </p>
            </section>

            <ReplacesRow appId={entry.id} />

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">{t("detail.information")}</h2>
                <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                    <Fact label={t("detail.developer")}>{t("polaris.developer")}</Fact>
                    <Fact label={t("detail.category")}>
                        {navLabel(switcherCategory(entry.category))}
                    </Fact>
                </dl>
            </section>
        </div>
    );
}
