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
import { useId, useMemo } from "react";
import { ReplacesRow } from "../replaces-row";
import { Trash2 } from "lucide-react";
import { DetailBack, DetailFacts, DetailHeader, DetailSection, Fact } from "@/components/store-detail";
import { Badge, Button } from "@polaris/ui";
import { ScreenshotGallery } from "./screenshot-gallery";
import { builtInSettingsHref } from "@/lib/apps/app-settings";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { builtInScreenshots } from "@/lib/apps/app-screenshots";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { BuiltInMark, BuiltInPreview, useBuiltInListing } from "../store-card";
import { findBuiltInApp, POLARIS_APPS_PATH } from "@/lib/apps/marketplace-store";
import { switcherCategory } from "../marketplace-view";

export function BuiltInAppDetail({ appId }: { appId: string }) {
    const t = useTranslations("marketplace");
    const navLabel = useNavLabel();
    const locale = useLocale();
    const toListing = useBuiltInListing();
    const reason = useId();
    const found = findBuiltInApp(appId);
    const entry = useMemo(() => (found ? toListing(found) : null), [found, toListing]);
    if (!entry) return null;
    const settingsHref = builtInSettingsHref(entry.id);
    const shots = builtInScreenshots(entry.id, locale);
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <DetailBack href={POLARIS_APPS_PATH}>{t("detail.back")}</DetailBack>

            <DetailHeader
                mark={<BuiltInMark entry={entry} size={72} />}
                name={entry.name}
                byline={t("polaris.builtInBy")}
            >
                <div>
                    <Badge>{t("polaris.builtIn")}</Badge>
                </div>
            </DetailHeader>

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

            {shots.length > 0 ? (
                <ScreenshotGallery name={entry.name} shots={shots} />
            ) : (
                <div className="max-w-2xl overflow-hidden rounded-lg border border-border">
                    <BuiltInPreview entry={entry} shot={null} />
                </div>
            )}

            <DetailSection title={t("detail.about")}>
                <p className="text-muted-foreground whitespace-pre-line break-words text-sm">
                    {entry.summary}
                </p>
            </DetailSection>

            <ReplacesRow appId={entry.id} />

            <DetailSection title={t("detail.information")}>
                <DetailFacts>
                    <Fact label={t("detail.developer")}>{t("polaris.developer")}</Fact>
                    <Fact label={t("detail.category")}>
                        {navLabel(switcherCategory(entry.category))}
                    </Fact>
                </DetailFacts>
            </DetailSection>
        </div>
    );
}
