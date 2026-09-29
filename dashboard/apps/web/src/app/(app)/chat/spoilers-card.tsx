"use client";

/**
 * Whether covers are taken off before this reader sees them.
 *
 * Per browser rather than per account, like the call volumes and the microphone
 * cleanup, and stated on the card so nobody expects it to follow them: it is a
 * statement about the screen somebody is reading on, and the laptop at home and
 * the one on a desk in an office want different answers.
 *
 * Off unless somebody says otherwise, which is the only defensible default: a
 * cover exists because a sender decided the thing under it should not arrive
 * unasked, and ignoring that by default would make marking something pointless.
 */

import { Card, CardBody, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setSpoilersShown, useSpoilersShown } from "./spoilers-shown";

export function SpoilersCard() {
    const t = useTranslations("account");
    const shown = useSpoilersShown();
    return (
        <Card>
            <CardBody className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{t("spoilers.title")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t("spoilers.body")}</p>
                </div>
                <Switch
                    checked={shown}
                    aria-label={t("spoilers.title")}
                    onChange={(next) => setSpoilersShown(next)}
                />
            </CardBody>
        </Card>
    );
}
