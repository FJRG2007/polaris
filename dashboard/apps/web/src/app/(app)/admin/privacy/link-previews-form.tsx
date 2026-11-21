"use client";

/**
 * The instance switch for link previews in Chat (ledger row 4). Off, this
 * server never fetches a posted address and no screen loads a card or player;
 * each account's and conversation's own switch only matters while it is on.
 */

import { useState } from "react";
import { setLinkPreviewsAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, Switch, useOptimisticToggle } from "@polaris/ui";

export function LinkPreviewsForm({ allowed }: { allowed: boolean }) {
    const t = useTranslations("admin");
    const [error, setError] = useState<string | null>(null);
    const [on, toggle] = useOptimisticToggle(
        allowed,
        async (next) => {
            setError(null);
            return setLinkPreviewsAction(next);
        },
        { onRefused: setError }
    );

    return (
        <Card>
            <CardBody className="flex flex-col divide-y divide-border py-1">
                <div className="flex items-start justify-between gap-3 py-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm">{t("privacy.previews.label")}</span>
                        <span id="privacy-link-previews" className="text-xs text-muted-foreground">
                            {t("privacy.previews.hint")}
                        </span>
                    </div>
                    <Switch
                        checked={on}
                        aria-label={t("privacy.previews.label")}
                        aria-describedby="privacy-link-previews"
                        onChange={toggle}
                    />
                </div>
                {error ? <p className="py-3 text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
