"use client";

/**
 * The sites Polar may always use in the person's browser, as the extension
 * reports them, each withdrawn with Forget. Polar asks before any other site,
 * so there is nothing to switch on. A forget drops the row at once and puts it
 * back if the browser did not take it.
 */

import Link from "next/link";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

interface SitesView {
    connected: boolean;
    sites: string[];
}

export function PolarBrowserSites() {
    const t = useTranslations("polar");
    const [view, setView] = useState<SitesView | null>(null);
    const [failed, setFailed] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        fetch("/api/polar/browser-sites")
            .then((response) => (response.ok ? (response.json() as Promise<SitesView>) : null))
            .then((found) => {
                if (live) setView(found ?? { connected: false, sites: [] });
            })
            .catch(() => live && setView({ connected: false, sites: [] }));
        return () => {
            live = false;
        };
    }, []);

    async function forget(site: string) {
        if (!view) return;
        setFailed(null);
        const before = view;
        setView({ ...view, sites: view.sites.filter((entry) => entry !== site) });
        const response = await fetch("/api/polar/browser-sites", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ site })
        }).catch(() => null);
        if (response?.ok) return;
        setView(before);
        setFailed(
            response?.status === 409
                ? t("settings.browserSites.notConnected")
                : t("settings.browserSites.forgetFailed")
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                {failed ? (
                    <p role="alert" className="text-sm text-danger">
                        {failed}
                    </p>
                ) : null}
                {!view ? (
                    <Skeleton className="h-10 w-full" />
                ) : !view.connected ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span className="min-w-0">{t("settings.browserSites.notConnected")}</span>
                        <Button size="sm" variant="outline" asChild>
                            <Link href="/account/downloads">{t("web.browserConnect")}</Link>
                        </Button>
                    </div>
                ) : view.sites.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {t("settings.browserSites.empty")}
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {view.sites.map((site) => (
                            <li key={site} className="flex items-center gap-3 py-2">
                                <p
                                    className="min-w-0 flex-1 truncate text-sm font-medium"
                                    title={site}
                                >
                                    {site}
                                </p>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    aria-label={t("settings.browserSites.forgetLabel", { site })}
                                    onClick={() => void forget(site)}
                                >
                                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                                    {t("settings.browserSites.forget")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
