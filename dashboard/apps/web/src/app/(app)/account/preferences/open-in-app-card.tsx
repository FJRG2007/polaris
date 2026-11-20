"use client";

/**
 * Whether a Polaris link followed in a browser opens in the Polaris app on that
 * device (`components/open-in-app`). Per account, and on unless turned off: it is
 * only ever tried where the account has signed in to the app, so somebody
 * without one never sees it.
 *
 * Saved as it is flipped, shown flipped at once and put back if the save fails.
 */

import { useState, useTransition } from "react";
import { Card, CardBody, Switch, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function OpenInAppCard({
    initial,
    save
}: {
    initial: boolean;
    save: (on: boolean) => Promise<{ error?: string }>;
}) {
    const t = useTranslations("account");
    const toast = useToast();
    const [on, setOn] = useState(initial);
    const [, start] = useTransition();

    const flip = (next: boolean) => {
        setOn(next);
        start(async () => {
            const result = await save(next).catch(() => ({ error: t("openInApp.failed") }));
            if (result.error) {
                setOn(!next);
                toast.show({ key: "open-in-app-save", title: result.error });
            }
        });
    };

    return (
        <Card id="open-in-app">
            <CardBody className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{t("openInApp.title")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t("openInApp.body")}</p>
                </div>
                <Switch checked={on} aria-label={t("openInApp.title")} onChange={flip} />
            </CardBody>
        </Card>
    );
}
