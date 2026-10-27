"use client";

/**
 * A port card whose first read failed. It says so in the card's own place rather
 * than drawing nothing, because a card that draws nothing reads as "nothing here
 * needs this port" - the opposite of "this could not be checked".
 */

import { Button } from "@polaris/ui";
import { PageSection } from "@/components/page-section";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function PortsReadFailed({
    id,
    title,
    refreshing,
    onRetry
}: {
    id: string;
    title: string;
    refreshing: boolean;
    onRetry: () => void;
}) {
    const t = useTranslations("admin");
    return (
        <PageSection id={id} title={title}>
            <div className="flex flex-wrap items-center gap-3">
                <p role="alert" className="text-sm text-danger">
                    {t("domainsPorts.readFailed")}
                </p>
                <Button variant="outline" size="sm" onClick={onRetry} disabled={refreshing}>
                    {t("domainsPorts.retry")}
                </Button>
            </div>
        </PageSection>
    );
}
